/* Chain Dominoes — Three.js render layer.
 * Café tabletop with tactile ceramic dominoes. Consumes immutable rules
 * snapshots; never mutates game state. Exposes pick events, legal-target
 * previews, deterministic decor, quality tiers, reduced-motion support,
 * and settle() so skip/fast-forward lands in the exact logical end state.
 *
 * Rendering direction follows the spec's skill routing: authored camera,
 * procedural geometry/materials/animation/VFX, explicit tone mapping and a
 * readable no-post baseline. Graphics settings (js/gfx.js, resolved by the UI)
 * layer on shadows, image-based lighting, surface detail, steam, window-light
 * shimmer and an optional post chain (GTAO, bloom, grade, FXAA/SMAA/MSAA)
 * built from the same-revision addons in vendor/three/addons.
 */
(function (root) {
  'use strict';

  /* ----------------------------------------------------------- constants */
  // Framing constants (no magic offsets scattered through the code).
  const FRAMING = {
    fov: 38,                       // low-distortion perspective
    camPos: [0, 26, 30],
    camLook: [0, 0, -2],
    introFrom: [0, 40, 52],        // authored intro swoop start
    tableSize: 72,
    feltSize: 56,
  };
  const TILE = { w: 2.0, l: 4.0, h: 0.85, gap: 0.35 };
  const CHAIN = { rowAdvance: 5.2, maxRow: 30.0 }; // serpentine layout
  const LAYERS = { ENV: 0, GAME: 1, GHOST: 2, FX: 3 }; // semantic grouping

  // Scene-linear (pre-tone-map) bloom threshold: above lit ivory and sugar,
  // below the boosted window glow and legal-end markers.
  const BLOOM_THRESHOLD = 2.2;

  // Steam point counts per `particles` tier.
  const STEAM = { low: 24, high: 120 };

  // Colour grade + vignette (display-space in, display-space out). Gentle:
  // pieces, pips and end markers must never lose contrast.
  const GradeShader = {
    uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.2 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette; varying vec2 vUv;',
      'void main() {',
      '  vec4 src = texture2D(tDiffuse, vUv); vec3 c = src.rgb; vec3 lc = clamp(c, 0.0, 1.0);',
      '  vec3 s = mix(lc, lc * lc * (3.0 - 2.0 * lc), 0.18);',            // S-curve contrast
      '  float l = dot(s, vec3(0.299, 0.587, 0.114));',
      '  s = mix(vec3(l), s, 1.07);',                                        // a touch more saturation
      '  s *= mix(vec3(0.97, 0.99, 1.04), vec3(1.04, 1.0, 0.95), smoothstep(0.2, 0.8, l));', // cool shadows, warm highlights
      '  c = mix(c, s + max(c - 1.0, 0.0), uAmount);',
      '  float d = length(vUv - 0.5);',
      '  c *= 1.0 - uVignette * smoothstep(0.4, 0.85, d);',
      '  gl_FragColor = vec4(c, src.a);',
      '}'].join('\n'),
  };

  function resolveGfx(opts) {
    const G = root.ChainDominoesGfx;
    if (opts.gfx) return opts.gfx;
    return G.resolve({ preset: opts.quality || 'auto' }, 'balanced');
  }

  /* ----------------------------------------------------- canvas textures */
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  const PIP_LAYOUTS = {
    0: [],
    1: [[0, 0]],
    2: [[-1, -1], [1, 1]],
    3: [[-1, -1], [0, 0], [1, 1]],
    4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
    5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
    6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
  };

  // Pips are drilled: a soft dark lip at the top-left, a lit rim at the
  // bottom-right and the pip colour in the well. `bump` draws a height map.
  function drawHalf(ctx, value, cx, cy, size, pipColor, bump) {
    const u = size / 3.2, r = size * 0.13;
    for (const [px, py] of PIP_LAYOUTS[value]) {
      const x = cx + px * u, y = cy + py * u;
      if (bump) {
        const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 1.15);
        g.addColorStop(0, '#000'); g.addColorStop(0.75, '#202020'); g.addColorStop(1, 'rgba(128,128,128,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, r * 1.15, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      ctx.fillStyle = 'rgba(255,255,255,0.55)';                 // lit lower rim
      ctx.beginPath(); ctx.arc(x + r * 0.12, y + r * 0.14, r * 1.08, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.28)';                       // shaded upper lip
      ctx.beginPath(); ctx.arc(x - r * 0.08, y - r * 0.1, r * 1.06, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = pipColor;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, 0, x, y, r);
      g.addColorStop(0, 'rgba(0,0,0,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0.08)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  // One texture per (a,b) face, cached. Ceramic face, grooved divider with a
  // brass spinner pin, drilled pips. Detailed surfaces use a 2x canvas and a
  // matching bump map (pips and groove recessed).
  function tileFaceTexture(a, b, theme, cache, detailed, bump) {
    const key = a + '-' + b + '-' + theme.id + (detailed ? '-d' : '') + (bump ? '-bump' : '');
    if (cache.has(key)) return cache.get(key);
    const S = detailed ? 256 : 128, k = S / 128;
    const c = makeCanvas(S, S * 2);
    const ctx = c.getContext('2d');
    if (bump) {
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.strokeStyle = '#303030'; ctx.lineWidth = 4 * k;
      ctx.beginPath(); ctx.moveTo(12 * k, S); ctx.lineTo(S - 12 * k, S); ctx.stroke();
      drawHalf(ctx, a, S / 2, S / 2, S * 0.72, '#000', true);
      drawHalf(ctx, b, S / 2, S * 1.5, S * 0.72, '#000', true);
    } else {
      ctx.fillStyle = '#' + new root.THREE.Color(theme.tileBody).getHexString();
      ctx.fillRect(0, 0, c.width, c.height);
      // subtle ceramic gradient + soft edge falloff
      const grad = ctx.createLinearGradient(0, 0, 0, c.height);
      grad.addColorStop(0, 'rgba(255,255,255,0.12)');
      grad.addColorStop(0.5, 'rgba(0,0,0,0.0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.10)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, c.width, c.height);
      const edge = ctx.createRadialGradient(S / 2, S, S * 0.6, S / 2, S, S * 1.25);
      edge.addColorStop(0, 'rgba(0,0,0,0)'); edge.addColorStop(1, 'rgba(60,40,20,0.10)');
      ctx.fillStyle = edge;
      ctx.fillRect(0, 0, c.width, c.height);
      // grooved divider: dark line with a light lower bevel
      ctx.lineWidth = 3 * k;
      ctx.strokeStyle = 'rgba(0,0,0,0.42)';
      ctx.beginPath(); ctx.moveTo(12 * k, S - 1 * k); ctx.lineTo(S - 12 * k, S - 1 * k); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.5 * k;
      ctx.beginPath(); ctx.moveTo(12 * k, S + 2 * k); ctx.lineTo(S - 12 * k, S + 2 * k); ctx.stroke();
      // brass spinner pin
      const pin = ctx.createRadialGradient(S / 2 - 2 * k, S - 2 * k, 0, S / 2, S, 6 * k);
      pin.addColorStop(0, '#fff3c4'); pin.addColorStop(0.45, '#caa24a'); pin.addColorStop(1, '#6d5220');
      ctx.fillStyle = pin;
      ctx.beginPath(); ctx.arc(S / 2, S, 5.5 * k, 0, Math.PI * 2); ctx.fill();
      const pip = '#' + new root.THREE.Color(theme.pip).getHexString();
      drawHalf(ctx, a, S / 2, S / 2, S * 0.72, pip, false);
      drawHalf(ctx, b, S / 2, S * 1.5, S * 0.72, pip, false);
    }
    const tex = new root.THREE.CanvasTexture(c);
    tex.anisotropy = detailed ? 8 : 4;
    if (!bump) tex.colorSpace = root.THREE.SRGBColorSpace;
    cache.set(key, tex);
    return tex;
  }

  // Soft round sprite for steam points (instead of square GL points).
  function softDotTexture() {
    const c = makeCanvas(64, 64);
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,0.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    const tex = new root.THREE.CanvasTexture(c);
    tex.colorSpace = root.THREE.SRGBColorSpace;
    return tex;
  }

  // Grey fibre noise used as a felt/wood bump map on detailed surfaces.
  function noiseTexture(size, seedStart, dots, repeat) {
    const c = makeCanvas(size, size);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, size, size);
    let seed = seedStart;
    const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < dots; i++) {
      const v = Math.floor(90 + rnd() * 80);
      ctx.strokeStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
      ctx.lineWidth = 0.6 + rnd();
      const x = rnd() * size, y = rnd() * size, a = rnd() * Math.PI * 2, l = 1 + rnd() * 3;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
    }
    const tex = new root.THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = root.THREE.RepeatWrapping;
    tex.repeat.set(repeat, repeat);
    return tex;
  }

  function tileBackTexture(theme, cache) {
    const key = 'back-' + theme.id;
    if (cache.has(key)) return cache.get(key);
    const S = 128;
    const c = makeCanvas(S, S * 2);
    const ctx = c.getContext('2d');
    const edge = '#' + new root.THREE.Color(theme.tileEdge).getHexString();
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 3;
    for (let i = -c.height; i < c.height * 2; i += 14) {
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(c.width, i + c.width); ctx.stroke();
    }
    const tex = new root.THREE.CanvasTexture(c);
    tex.colorSpace = root.THREE.SRGBColorSpace;
    cache.set(key, tex);
    return tex;
  }

  function woodTexture(theme) {
    const S = 512;
    const c = makeCanvas(S, S);
    const ctx = c.getContext('2d');
    const base = new root.THREE.Color(theme.table);
    ctx.fillStyle = '#' + base.getHexString();
    ctx.fillRect(0, 0, S, S);
    // plank grain: horizontal streaks with deterministic wobble
    let seed = 12345;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 90; i++) {
      const y = rnd() * S;
      const dark = rnd() > 0.5;
      ctx.strokeStyle = dark ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1 + rnd() * 3;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= S; x += 32) ctx.lineTo(x, y + Math.sin(x * 0.02 + i) * 4 * rnd());
      ctx.stroke();
    }
    const tex = new root.THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = root.THREE.RepeatWrapping;
    tex.repeat.set(2, 2);
    tex.colorSpace = root.THREE.SRGBColorSpace;
    return tex;
  }

  // Café wall: tongue-and-groove wainscot below a plaster band, with a warm
  // falloff away from the window (drawn once per theme).
  function wallTexture(theme) {
    const W = 512, H = 256;
    const c = makeCanvas(W, H);
    const ctx = c.getContext('2d');
    const base = new root.THREE.Color(theme.wall);
    ctx.fillStyle = '#' + base.getHexString();
    ctx.fillRect(0, 0, W, H);
    const rail = H * 0.62;
    // plaster band: soft mottling
    let seed = 777;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 400; i++) {
      ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.03)';
      ctx.beginPath(); ctx.arc(rnd() * W, rnd() * rail, 4 + rnd() * 14, 0, Math.PI * 2); ctx.fill();
    }
    // wainscot planks
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(0, rail, W, H - rail);
    for (let x = 0; x < W; x += 32) {
      ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(x, rail, 2, H - rail);
      ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fillRect(x + 2, rail, 1, H - rail);
    }
    // chair rail moulding
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(0, rail - 6, W, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(0, rail - 6, W, 2);
    const tex = new root.THREE.CanvasTexture(c);
    tex.wrapS = root.THREE.RepeatWrapping;
    tex.repeat.set(3, 1);
    tex.colorSpace = root.THREE.SRGBColorSpace;
    return tex;
  }

  function feltTexture(theme) {
    const S = 256;
    const c = makeCanvas(S, S);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#' + new root.THREE.Color(theme.felt).getHexString();
    ctx.fillRect(0, 0, S, S);
    let seed = 999;
    const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 3000; i++) {
      ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.03)';
      ctx.fillRect(rnd() * S, rnd() * S, 1.5, 1.5);
    }
    const tex = new root.THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = root.THREE.RepeatWrapping;
    tex.repeat.set(3, 3);
    tex.colorSpace = root.THREE.SRGBColorSpace;
    return tex;
  }

  function labelSprite(text, color) {
    const c = makeCanvas(128, 128);
    const ctx = c.getContext('2d');
    ctx.font = 'bold 84px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = color || '#ffffff';
    ctx.fillText(String(text), 64, 70);
    const tex = new root.THREE.CanvasTexture(c);
    tex.colorSpace = root.THREE.SRGBColorSpace;
    const mat = new root.THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sp = new root.THREE.Sprite(mat);
    sp.scale.set(2.4, 2.4, 1);
    return sp;
  }

  /* -------------------------------------------------------- tile geometry */
  function roundedRectShape(w, l, r) {
    const s = new root.THREE.Shape();
    const x = -w / 2, y = -l / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + l - r); s.quadraticCurveTo(x + w, y + l, x + w - r, y + l);
    s.lineTo(x + r, y + l); s.quadraticCurveTo(x, y + l, x, y + l - r);
    s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
    return s;
  }

  function makeTileGeometry() {
    const THREE = root.THREE;
    const shape = roundedRectShape(TILE.w, TILE.l, 0.32);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: TILE.h, bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.1, bevelSegments: 2, curveSegments: 6,
    });
    // ExtrudeGeometry UVs are raw shape coordinates — normalize to [0,1]
    // so the face texture maps cleanly onto the cap.
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i,
        (uv.getX(i) - bb.min.x) / (bb.max.x - bb.min.x),
        (uv.getY(i) - bb.min.y) / (bb.max.y - bb.min.y));
    }
    uv.needsUpdate = true;
    geo.rotateX(-Math.PI / 2); // lie flat, face up
    geo.translate(0, TILE.h / 2 + 0.1, 0);
    return geo;
  }

  /* ================================================================== */
  class ChainRenderer {
    constructor(canvas, opts) {
      opts = opts || {};
      const THREE = root.THREE;
      if (!THREE) throw new Error('THREE not loaded');
      this.THREE = THREE;
      this.canvas = canvas;
      this.theme = opts.theme;
      this.reducedMotion = !!opts.reducedMotion;
      this.gfx = resolveGfx(opts);
      // Ambient motion (steam, light shimmer) also honours the OS preference.
      this._osReduced = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
      this.texCache = new Map();
      this.tileMeshes = new Map();     // tileId -> {mesh, target:{pos,rotY,tilt}, spring state}
      this.opponentStacks = [];        // face-down tile rows
      this.boneyardMeshes = [];
      this.picking = [];
      this.onPick = null;
      this.hovered = null;
      this.selectedTile = null;
      this.legalEnds = [];
      this.ghost = null;
      this._anims = [];
      this._running = true;
      this._disposed = false;
      this._camT = this.reducedMotion ? 1 : 0; // intro swoop progress
      this._shake = 0;
      this._lastTime = 0;
      this._steam = null;

      const g = this.gfx;
      // Canvas MSAA is a context attribute (fixed at creation); a later switch
      // to MSAA is served by a multisampled composer target instead.
      this._ctxAA = g.antialias === 'msaa';
      this.renderer = new THREE.WebGLRenderer({
        canvas, antialias: this._ctxAA, powerPreference: 'high-performance',
      });
      this.adaptiveScale = 1;
      this._frames = [];
      this.fps = 0;
      this.composer = null;
      this.postKey = null;
      this.postFailed = false;
      this.addons = null;
      this.onPostStatus = null;
      this.renderer.setPixelRatio(this._pixelRatio());
      this.renderer.shadowMap.enabled = g.shadowMap > 0;
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = this.theme.exposure || 1.05;

      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(this.theme.fog); // background via scene (not clear colour) so post keeps it
      this.scene.environmentIntensity = 0.3;
      this.scene.fog = new THREE.Fog(this.theme.fog, 70, 160);

      this.camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.5, 300);
      this._applyCamera(this._camT);

      this._buildEnvironment();
      this._buildMarkers();
      this._bindPointer();
      this._onResize = () => this.resize();
      window.addEventListener('resize', this._onResize);
      // React to layout changes (screen activation, drawers, orientation)
      if (typeof ResizeObserver === 'function' && canvas.parentElement) {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(canvas.parentElement);
      }
      this.resize();
      this.setGraphics(this.gfx);

      // Addons (post chain, RoomEnvironment) load asynchronously; the table
      // renders without them until they arrive, or for good if they fail.
      Promise.resolve(root.CD_ADDONS).then((a) => {
        if (this._disposed) return;
        this.addons = a || null;
        if (!a) this._setPostFailed(true);
        this._applyReflections();
        this.postKey = null;
      }, () => { this._setPostFailed(true); });

      this.renderer.setAnimationLoop((t) => this._frame(t));
    }

    /* ------------------------------------------------------------ camera */
    _applyCamera(t) {
      // Authored swoop: cubic ease from introFrom to camPos. Interruptible:
      // setting _camT = 1 snaps instantly (used by reduced motion / skip).
      const THREE = this.THREE;
      const ease = t >= 1 ? 1 : 1 - Math.pow(1 - t, 3);
      const lerp = (a, b) => a + (b - a) * ease;
      const p = FRAMING.introFrom, q = this._topDown ? [0, 62, 0.01] : FRAMING.camPos;
      const ds = this._distScale || 1;
      this.camera.position.set(lerp(p[0], q[0]) * ds, lerp(p[1], q[1]) * ds, lerp(p[2], q[2]) * ds);
      this.camera.lookAt(FRAMING.camLook[0], FRAMING.camLook[1], FRAMING.camLook[2]);
      this._baseCamPos = this.camera.position.clone();
    }

    resetCamera() { this._topDown = false; this._camT = 1; this._fitCamera(); this._applyCamera(1); }
    toggleTopDown() { this._topDown = !this._topDown; this._camT = 1; this._fitCamera(); this._applyCamera(1); return this._topDown; }

    // Pull the camera back until the hand arc and the chain area project
    // inside the canvas with a margin (the canvas itself is unobscured: the
    // HTML tray and rails sit outside it).
    _fitCamera() {
      const THREE = this.THREE;
      const q = this._topDown ? [0, 62, 0.01] : FRAMING.camPos;
      const look = new THREE.Vector3(FRAMING.camLook[0], FRAMING.camLook[1], FRAMING.camLook[2]);
      const pts = [];
      for (const x of [-13.5, 13.5]) pts.push(new THREE.Vector3(x, 2.4, 16.8)); // standing hand, front
      for (const x of [-14, 14]) pts.push(new THREE.Vector3(x, 0, -14));        // chain rows
      pts.push(new THREE.Vector3(0, 0, -18));
      const v = new THREE.Vector3();
      let ds = 1;
      const margin = 0.9;
      for (let i = 0; i < 14; i++) {
        this.camera.position.set(q[0] * ds, q[1] * ds, q[2] * ds);
        this.camera.lookAt(look);
        this.camera.updateMatrixWorld();
        this.camera.updateProjectionMatrix();
        let worst = 0;
        for (const p of pts) {
          v.copy(p).project(this.camera);
          // the bottom strip (HTML chain mirror) covers ~12% of the canvas
          const yLimit = v.y < 0 ? 0.74 : margin;
          worst = Math.max(worst, Math.abs(v.x), Math.abs(v.y) * (margin / yLimit));
        }
        if (worst <= margin) break;
        ds *= Math.min(1.5, worst / margin + 0.01);
      }
      this._distScale = ds;
    }

    shake(amount) {
      if (this.reducedMotion) return;
      this._shake = Math.min(0.5, amount);
    }

    /* -------------------------------------------------------- environment */
    _buildEnvironment() {
      const THREE = this.THREE, t = this.theme;

      // Key light (window), warm. Its shadow box is fitted to the play area
      // (felt, hand arc, cup, boneyard) rather than the whole table.
      const boost = this.theme.lightBoost || 1;
      const key = new THREE.DirectionalLight(0xfff2dd, 2.2 * boost);
      key.position.set(-18, 34, 18);
      key.shadow.camera.left = -31; key.shadow.camera.right = 31;
      key.shadow.camera.top = 27; key.shadow.camera.bottom = -27;
      key.shadow.camera.near = 10; key.shadow.camera.far = 90;
      key.shadow.bias = -0.0004;
      key.shadow.normalBias = 0.03;
      key.shadow.radius = 3;
      this.scene.add(key);
      this.keyLight = key;
      this._keyBase = key.intensity;
      // Soft environment fill
      const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x3a2c1e, 0.55 * boost);
      this.scene.add(hemi);
      this.hemiLight = hemi;
      // Small warm café pendant
      const pendant = new THREE.PointLight(new THREE.Color(t.accent), 12, 60, 1.8);
      pendant.position.set(10, 22, -10);
      this.scene.add(pendant);
      this.pendant = pendant;
      this._pendantBase = pendant.intensity;

      // Table
      const woodMap = woodTexture(t);
      const tableMat = new THREE.MeshStandardMaterial({ map: woodMap, roughness: 0.62, metalness: 0.05 });
      tableMat.userData.bump = { map: woodMap, scale: 1.2 };
      const table = new THREE.Mesh(new THREE.BoxGeometry(FRAMING.tableSize, 2.4, FRAMING.tableSize), tableMat);
      table.position.y = -1.2;
      table.receiveShadow = true;
      this.scene.add(table);

      // Felt playing mat with rounded look (thin box)
      const feltMat = new THREE.MeshStandardMaterial({ map: feltTexture(t), roughness: 0.95, metalness: 0 });
      feltMat.userData.bump = { map: noiseTexture(256, 4242, 5000, 6), scale: 1.6 };
      feltMat.userData.envIntensity = 0.08; // felt barely reflects
      const felt = new THREE.Mesh(new THREE.BoxGeometry(FRAMING.feltSize, 0.18, FRAMING.feltSize * 0.78), feltMat);
      felt.position.y = 0.09;
      felt.receiveShadow = true;
      this.scene.add(felt);

      // Leather-bound felt edge: a thin raised band framing the playing area.
      const bandCol = new THREE.Color(t.felt).lerp(new THREE.Color(0x1a120b), 0.72);
      const bandMat = new THREE.MeshStandardMaterial({ color: bandCol, roughness: 0.48, metalness: 0.0 });
      const fw = FRAMING.feltSize, fd = FRAMING.feltSize * 0.78, bw = 0.9;
      const band = new THREE.Group();
      for (const [w, d, x, z] of [[fw + bw * 2, bw, 0, -fd / 2 - bw / 2], [fw + bw * 2, bw, 0, fd / 2 + bw / 2],
        [bw, fd, -fw / 2 - bw / 2, 0], [bw, fd, fw / 2 + bw / 2, 0]]) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.34, d), bandMat);
        m.position.set(x, 0.17, z);
        m.receiveShadow = true;
        band.add(m);
      }
      this.scene.add(band);
      this._detailMats = [tableMat, feltMat];

      // Café backdrop: wall plane + window glow + shelf (simple silhouettes)
      const wallMat = new THREE.MeshStandardMaterial({ map: wallTexture(t), roughness: 1 });
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(200, 90), wallMat);
      wall.position.set(0, 30, -70);
      this.scene.add(wall);
      const winGlow = new THREE.Mesh(
        new THREE.PlaneGeometry(46, 34),
        new THREE.MeshBasicMaterial({ color: 0xffe9c4, transparent: true, opacity: 0.5 })
      );
      winGlow.position.set(-38, 34, -69);
      this.scene.add(winGlow);
      this.winGlow = winGlow;
      // Window mullions: a cross of dark bars over the glow.
      const barMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(t.wall).multiplyScalar(0.55), roughness: 0.9 });
      for (const [w, h, x, y] of [[1.2, 34, -38, 34], [46, 1.2, -38, 34], [47.5, 1.6, -38, 17.2], [47.5, 1.6, -38, 50.8]]) {
        const bar = new THREE.Mesh(new THREE.PlaneGeometry(w, h), barMat);
        bar.position.set(x, y, -68.8);
        this.scene.add(bar);
      }

      // Coffee cup + saucer + steam (procedural props, deterministic decor)
      this._buildCup();
      this._buildCrumbs();
    }

    _buildCup() {
      const THREE = this.THREE, t = this.theme;
      const cupMat = new THREE.MeshPhysicalMaterial({ color: t.cupColor, roughness: 0.3, metalness: 0.02, clearcoatRoughness: 0.12 });
      cupMat.userData.glaze = 0.9;
      this._glazeMats = [cupMat];
      const CUP = { x: -22.5, z: -9 }; // clear of the chain serpentine
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 1.7, 2.6, 24, 1, true), cupMat);
      cup.position.set(CUP.x, 1.4, CUP.z);
      cup.userData.caster = true;
      this.scene.add(cup);
      const bottom = new THREE.Mesh(new THREE.CircleGeometry(1.7, 24), cupMat);
      bottom.rotation.x = -Math.PI / 2;
      bottom.position.set(CUP.x, 0.12, CUP.z);
      this.scene.add(bottom);
      const coffee = new THREE.Mesh(
        new THREE.CircleGeometry(1.9, 24),
        new THREE.MeshStandardMaterial({ color: 0x2a180e, roughness: 0.25 })
      );
      coffee.rotation.x = -Math.PI / 2;
      coffee.position.set(CUP.x, 2.55, CUP.z);
      this.scene.add(coffee);
      // Crema ring on the coffee
      const crema = new THREE.Mesh(
        new THREE.RingGeometry(1.35, 1.9, 32),
        new THREE.MeshStandardMaterial({ color: 0x8a5a32, roughness: 0.4, transparent: true, opacity: 0.8 })
      );
      crema.rotation.x = -Math.PI / 2;
      crema.position.set(CUP.x, 2.56, CUP.z);
      this.scene.add(crema);
      const saucer = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 2.6, 0.35, 28), cupMat);
      saucer.position.set(CUP.x, 0.18, CUP.z);
      saucer.receiveShadow = true;
      this.scene.add(saucer);
      // handle: torus segment
      const handle = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.22, 10, 20, Math.PI), cupMat);
      handle.position.set(CUP.x + 2.15, 1.5, CUP.z);
      handle.rotation.z = -Math.PI / 2;
      this.scene.add(handle);
      this._cupPos = CUP;
      this._buildSteam();
    }

    // Steam: bounded CPU-updated soft points that rise, sway and fade;
    // cosmetic only, no raycast. Count follows the `particles` tier.
    _buildSteam() {
      const THREE = this.THREE, CUP = this._cupPos;
      if (this._steam) {
        this.scene.remove(this._steam);
        this._steam.geometry.dispose();
        this._steam.material.dispose();
      }
      const count = STEAM[this.gfx.particles] || STEAM.low;
      const positions = new Float32Array(count * 3);
      const colors = new Float32Array(count * 4);
      const phases = new Float32Array(count);
      const rng = this._seededRng('steam');
      for (let i = 0; i < count; i++) {
        positions[i * 3] = CUP.x + (rng() - 0.5) * 1.6;
        positions[i * 3 + 1] = 2.6 + rng() * 5.4;
        positions[i * 3 + 2] = CUP.z + (rng() - 0.5) * 1.6;
        phases[i] = rng() * Math.PI * 2;
        colors[i * 4] = colors[i * 4 + 1] = colors[i * 4 + 2] = 1;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
      if (!this._dotTex) this._dotTex = softDotTexture();
      const mat = new THREE.PointsMaterial({
        size: count > 40 ? 0.9 : 1.1, map: this._dotTex, vertexColors: true,
        transparent: true, opacity: count > 40 ? 0.22 : 0.3, depthWrite: false,
      });
      const pts = new THREE.Points(geo, mat);
      pts.raycast = () => {}; // cosmetics never intercept raycasts
      pts.userData.phases = phases;
      this.scene.add(pts);
      this._steam = pts;
      this._updateSteam(0, 0);
    }

    _updateSteam(time, dt) {
      const pos = this._steam.geometry.attributes.position;
      const col = this._steam.geometry.attributes.color;
      const phases = this._steam.userData.phases;
      const cx = this._cupPos.x;
      for (let i = 0; i < pos.count; i++) {
        let y = pos.getY(i) + dt * 0.9;
        if (y > 8) y = 2.6;
        pos.setY(i, y);
        const rise = (y - 2.6) / 5.4;
        pos.setX(i, cx + Math.sin(time * 0.001 + phases[i]) * (0.4 + rise * 0.8));
        col.setW(i, Math.sin(Math.PI * Math.min(1, rise)) * 0.9 + 0.1);
      }
      pos.needsUpdate = true;
      col.needsUpdate = true;
    }

    _buildCrumbs() {
      // Deterministic table scatter (sugar cubes), instanced.
      const THREE = this.THREE;
      const n = 8;
      const rng = this._decorRng || (this._decorRng = this._seededRng('decor'));
      const geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
      const mat = new THREE.MeshStandardMaterial({ color: 0xf5f0e2, roughness: 0.9 });
      const inst = new THREE.InstancedMesh(geo, mat, n);
      const m = new THREE.Matrix4();
      for (let i = 0; i < n; i++) {
        const x = 18 + rng() * 6, z = -17 + rng() * 5;
        m.makeRotationY(rng() * Math.PI);
        m.setPosition(x, 0.35, z);
        inst.setMatrixAt(i, m);
      }
      inst.userData.caster = true;
      this.scene.add(inst);
      this._crumbs = inst;
    }

    _seededRng(label) {
      // deterministic decor stream from theme+label; not rules-affecting
      let s = 2166136261;
      const str = (this.theme ? this.theme.id : 'x') + ':' + label;
      for (let i = 0; i < str.length; i++) { s ^= str.charCodeAt(i); s = Math.imul(s, 16777619); }
      return function () {
        s |= 0; s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    /* ------------------------------------------------------ board markers */
    _buildMarkers() {
      const THREE = this.THREE;
      // End markers: flat rings at the two open ends.
      const mk = (color) => {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(1.8, 0.24, 10, 32),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.visible = false;
        ring.userData.interactive = { kind: 'end' };
        this.scene.add(ring);
        return ring;
      };
      this.endMarkers = { left: mk(this.theme.accent2), right: mk(this.theme.accent2) };
      this.endMarkers.left.userData.interactive.end = 'left';
      this.endMarkers.right.userData.interactive.end = 'right';
      this.endLabels = { left: null, right: null };
      this.picking.push(this.endMarkers.left, this.endMarkers.right);

      // Ghost tile for target preview
      const ghost = new THREE.Mesh(
        makeTileGeometry(),
        new THREE.MeshBasicMaterial({ color: this.theme.accent, transparent: true, opacity: 0.35, depthWrite: false })
      );
      ghost.visible = false;
      ghost.raycast = () => {};
      this.scene.add(ghost);
      this.ghost = ghost;

      // Selection ring (grounded marker under the selected hand tile)
      const sel = new THREE.Mesh(
        new THREE.TorusGeometry(1.5, 0.14, 10, 32),
        new THREE.MeshBasicMaterial({ color: this.theme.accent, transparent: true, opacity: 0.95 })
      );
      sel.rotation.x = -Math.PI / 2;
      sel.visible = false;
      sel.raycast = () => {};
      this.scene.add(sel);
      this.selRing = sel;
    }

    /* ------------------------------------------------------------ pointer */
    _bindPointer() {
      const ray = new this.THREE.Raycaster();
      const ptr = new this.THREE.Vector2();
      const toNDC = (e) => {
        const r = this.canvas.getBoundingClientRect();
        ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
        ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      };
      let downAt = null, downPos = null;
      this.canvas.addEventListener('pointerdown', (e) => {
        downAt = performance.now(); downPos = [e.clientX, e.clientY];
        try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
      });
      this.canvas.addEventListener('pointerup', (e) => {
        if (downPos === null) return;
        const dt = performance.now() - downAt;
        const dist = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
        downPos = null;
        if (dt > 450 || dist > 12) return; // drag/camera gesture, not a tap
        toNDC(e);
        ray.setFromCamera(ptr, this.camera);
        const hits = ray.intersectObjects(this.picking.filter(o => o.visible), false);
        if (hits.length && this.onPick) {
          const info = hits[0].object.userData.interactive;
          if (info) this.onPick(info);
        } else if (this.onPick) {
          this.onPick({ kind: 'table' });
        }
      });
      this.canvas.addEventListener('pointercancel', () => { downPos = null; });
      this.canvas.addEventListener('pointermove', (e) => {
        toNDC(e);
        ray.setFromCamera(ptr, this.camera);
        const hits = ray.intersectObjects(this.picking.filter(o => o.visible), false);
        const hit = hits.length ? hits[0].object.userData.interactive : null;
        if (hit !== this.hovered) {
          this.hovered = hit;
          this.canvas.style.cursor = hit ? 'pointer' : 'default';
        }
      });
    }

    /* ------------------------------------------------------- state sync */
    // Compute deterministic table position for chain index i.
    _chainSlot(i, isDouble) {
      const adv = TILE.w + TILE.gap;
      let x = 0, row = 0, dir = 1;
      // Walk slots: each row holds maxRow/advance tiles.
      const perRow = Math.floor(CHAIN.maxRow / adv);
      row = Math.floor(i / perRow);
      const idx = i % perRow;
      dir = row % 2 === 0 ? 1 : -1;
      const xx = dir === 1 ? idx : perRow - 1 - idx;
      x = -CHAIN.maxRow / 2 + xx * adv + adv / 2;
      const z = -14 + row * CHAIN.rowAdvance;
      return { x, z, rotY: 0 }; // tiles lie flat, long axis across chain dir
    }

    // Sync from an immutable snapshot. instant = settle immediately.
    syncState(view, instant) {
      const THREE = this.THREE;
      const seen = new Set();
      const want = new Map(); // tileId -> {pos, rotY, faceUp, lift}

      // Chain tiles
      view.chain.forEach((c, i) => {
        const slot = this._chainSlot(i, c.double);
        want.set(c.id, {
          pos: [slot.x, 0.2, slot.z], rotY: c.double ? Math.PI / 2 : 0,
          faceUp: true, face: [c.a, c.b], group: 'chain', order: i,
        });
      });

      // My hand: upright arc at the front, facing camera
      const my = view.myHand || [];
      const spread = Math.min(24, my.length * 2.6);
      my.forEach((id, i) => {
        const t = my.length <= 1 ? 0 : (i / (my.length - 1)) - 0.5;
        const x = t * spread;
        const z = 15.5 - Math.abs(t) * 2.0;
        want.set(id, {
          pos: [x, 0.2, z], rotY: 0, tilt: -0.28, standing: true,
          faceUp: true, face: view.tileFaces ? view.tileFaces[id] : null, group: 'hand', order: i,
        });
      });

      // Opponents: face-down standing rows at their table edges
      (view.opponents || []).forEach((opp, oi) => {
        const posSlots = view.opponentPositions[oi]; // {x,z,rotY}
        for (let i = 0; i < opp.count; i++) {
          const key = 'opp-' + oi + '-' + i;
          const spread2 = Math.min(14, opp.count * 1.5);
          const t = opp.count <= 1 ? 0 : (i / (opp.count - 1)) - 0.5;
          want.set(key, {
            pos: [posSlots.x + t * spread2 * Math.cos(posSlots.rotY), 0.2,
                  posSlots.z + t * spread2 * Math.sin(posSlots.rotY)],
            rotY: posSlots.rotY, tilt: 0.24, standing: true, faceUp: false, group: 'opp', order: i,
          });
        }
      });

      // Boneyard: face-down stack, right side (inside the camera frustum)
      for (let i = 0; i < (view.boneyardCount || 0); i++) {
        const key = 'bone-' + i;
        want.set(key, {
          pos: [16.2 + (i % 3) * 0.25, 0.2 + Math.floor(i / 3) * (TILE.h + 0.06), 10.2 + (i % 3) * 0.25],
          rotY: Math.PI / 2, standing: false, faceUp: false, group: 'bone', order: i,
        });
      }

      // Create missing meshes, mark removals
      for (const [key, w] of want) {
        seen.add(key);
        let entry = this.tileMeshes.get(key);
        if (!entry) {
          entry = this._makeTile(key, w);
          this.tileMeshes.set(key, entry);
          entry.mesh.position.set(w.pos[0], instant ? w.pos[1] : w.pos[1] + 6, w.pos[2]);
        }
        entry.target = w;
        this._setInteractive(entry, w.group === 'hand');
        if (w.faceUp && w.face) {
          this._setTileFace(entry, w.face[0], w.face[1]);
        }
        if (instant) this._snapTo(entry, w);
      }
      for (const [key, entry] of this.tileMeshes) {
        if (!seen.has(key)) {
          if (instant) this._removeTile(key);
          else this._animateOut(key, entry);
        }
      }

      // End markers
      this._syncEndMarkers(view, instant);

      // Keep selection ring on the selected tile
      this._syncSelectionVisual();
    }

    _makeTile(key, w) {
      const THREE = this.THREE;
      const mats = [];
      // Physical ceramic: clearcoat glaze on detailed surfaces (0 = plain).
      const glaze = this.gfx.detail === 'detailed';
      const edgeMat = new THREE.MeshPhysicalMaterial({
        color: this.theme.tileEdge, roughness: 0.4, metalness: 0.02,
        clearcoat: glaze ? 0.55 : 0, clearcoatRoughness: 0.22,
      });
      const faceMat = new THREE.MeshPhysicalMaterial({
        color: this.theme.tileBody, roughness: 0.35, metalness: 0.02,
        clearcoat: glaze ? 0.8 : 0, clearcoatRoughness: 0.16,
      });
      const backMat = new THREE.MeshStandardMaterial({
        map: tileBackTexture(this.theme, this.texCache), roughness: 0.5,
      });
      // ExtrudeGeometry groups: 0 = front/back faces, 1 = side walls
      const mesh = new THREE.Mesh(makeTileGeometry(), [faceMat, edgeMat]);
      mesh.castShadow = this.gfx.shadowMap > 0;
      mesh.userData.caster = true;
      mesh.receiveShadow = true;
      const entry = {
        key, mesh, faceMat, edgeMat, backMat,
        vel: new THREE.Vector3(), rotVel: 0,
        target: w, faceUpShown: w.faceUp !== false, removing: false,
      };
      mesh.userData.entry = entry;
      if (w.group === 'hand') {
        mesh.userData.interactive = { kind: 'tile', tileId: key };
        this.picking.push(mesh);
      }
      this.scene.add(mesh);
      this._applyFaceVisibility(entry);
      return entry;
    }

    _setTileFace(entry, a, b) {
      const detailed = this.gfx.detail === 'detailed';
      entry.face = [a, b];
      const tex = tileFaceTexture(a, b, this.theme, this.texCache, detailed, false);
      const bump = detailed ? tileFaceTexture(a, b, this.theme, this.texCache, true, true) : null;
      if (entry.faceMat.map !== tex || entry.faceMat.bumpMap !== bump) {
        entry.faceMat.map = tex;
        entry.faceMat.bumpMap = bump;
        entry.faceMat.bumpScale = 2.5;
        entry.faceMat.needsUpdate = true;
      }
    }

    _applyFaceVisibility(entry) {
      // Face texture on top when faceUp; otherwise show back pattern on top.
      const faceTex = entry.faceMat.map;
      if (entry.faceUpShown) {
        entry.faceMat.map = faceTex; // set via _setTileFace for chain/hand
      } else {
        entry.faceMat.map = null;
        entry.faceMat.color = new this.THREE.Color(this.theme.tileEdge);
      }
      entry.faceMat.needsUpdate = true;
    }

    _setInteractive(entry, on) {
      const idx = this.picking.indexOf(entry.mesh);
      if (on && idx < 0) {
        entry.mesh.userData.interactive = { kind: 'tile', tileId: entry.key };
        this.picking.push(entry.mesh);
      } else if (!on && idx >= 0) {
        delete entry.mesh.userData.interactive;
        this.picking.splice(idx, 1);
      }
    }

    _removeTile(key) {
      const entry = this.tileMeshes.get(key);
      if (!entry) return;
      this.scene.remove(entry.mesh);
      const pi = this.picking.indexOf(entry.mesh);
      if (pi >= 0) this.picking.splice(pi, 1);
      entry.mesh.geometry.dispose();
      this.tileMeshes.delete(key);
    }

    _animateOut(key, entry) {
      if (entry.removing) return;
      entry.removing = true;
      entry.target = { pos: [entry.mesh.position.x, 8, entry.mesh.position.z], fade: true, remove: true };
    }

    _snapTo(entry, w) {
      entry.mesh.position.set(w.pos[0], w.pos[1], w.pos[2]);
      entry.mesh.rotation.set(0, 0, 0);
      const targetRotY = w.rotY || 0;
      const targetTiltX = w.standing ? (Math.PI / 2 + (w.tilt || 0) * (w.group === 'hand' ? 1 : -1)) : 0;
      entry.mesh.rotation.set(w.standing ? targetTiltX : 0, targetRotY, 0, 'YXZ');
      if (!w.faceUp) { entry.mesh.rotation.x = w.standing ? -targetTiltX : Math.PI; }
      entry.vel.set(0, 0, 0);
    }

    _syncEndMarkers(view, instant) {
      const THREE = this.THREE;
      const showMarkers = view.myTurn && view.selectedPlayable;
      const positions = { left: null, right: null };
      if (view.chain.length > 0) {
        const first = view.chain[0], last = view.chain[view.chain.length - 1];
        const s0 = this._chainSlot(0, first.double);
        const s1 = this._chainSlot(view.chain.length - 1, last.double);
        positions.left = [s0.x - 2.6, 0.25, s0.z];
        positions.right = [s1.x + 2.6, 0.25, s1.z];
      } else {
        positions.left = [0, 0.25, -14];
        positions.right = [0, 0.25, -14];
      }
      for (const end of ['left', 'right']) {
        const marker = this.endMarkers[end];
        const legal = showMarkers && view.legalEnds && view.legalEnds.includes(end);
        marker.visible = !!(legal && positions[end]);
        if (marker.visible) {
          marker.position.set(positions[end][0], positions[end][1], positions[end][2]);
          // With bloom on, markers are pushed past the bloom threshold so the
          // legal ends glow; without it they keep the plain accent colour.
          marker.material.color = new THREE.Color(this.theme.accent).multiplyScalar(this._glow || 1);
        }
        // value labels
        const val = end === 'left' ? view.leftEnd : view.rightEnd;
        if (marker.visible && val !== null && val !== undefined) {
          if (!this.endLabels[end]) {
            this.endLabels[end] = labelSprite(val, '#fff');
            this.scene.add(this.endLabels[end]);
          }
          const lbl = this.endLabels[end];
          lbl.visible = true;
          lbl.position.set(positions[end][0], 2.2, positions[end][2]);
          // refresh text if changed
          if (lbl.userData.val !== val) {
            lbl.userData.val = val;
            lbl.material.map.dispose();
            const fresh = labelSprite(val, '#fff');
            lbl.material.map = fresh.material.map;
          }
        } else if (this.endLabels[end]) {
          this.endLabels[end].visible = false;
        }
      }

      // Ghost preview of the selected tile at hovered end
      if (this.ghost) {
        const showGhost = showMarkers && this.hovered && this.hovered.kind === 'end' &&
          view.legalEnds && view.legalEnds.includes(this.hovered.end) && positions[this.hovered.end];
        this.ghost.visible = !!showGhost;
        if (showGhost) {
          const p = positions[this.hovered.end];
          this.ghost.position.set(p[0], 0.25, p[2]);
        }
      }
    }

    setSelected(tileKey) {
      this.selectedTile = tileKey;
      this._syncSelectionVisual();
    }

    _syncSelectionVisual() {
      const key = this.selectedTile;
      const entry = key ? this.tileMeshes.get(key) : null;
      if (entry && !entry.removing) {
        this.selRing.visible = true;
        this.selRing.position.set(entry.mesh.position.x, 0.22, entry.mesh.position.z);
      } else {
        this.selRing.visible = false;
      }
      // lift selected / dim non-playable
      for (const [, e] of this.tileMeshes) {
        const isSel = e.key === key;
        const lift = isSel ? 0.9 : 0;
        if (e.target && !e.target.remove) e.target.lift = lift;
        if (e.faceMat && e.faceMat.emissive) {
          e.faceMat.emissive = new this.THREE.Color(isSel ? this.theme.accent : 0x000000);
          e.faceMat.emissiveIntensity = isSel ? 0.25 : 0;
        }
      }
    }

    // Legal-target hints from session: {ends:['left'|'right']}
    setLegalEnds(ends) { this.legalEnds = ends || []; }

    // Fast-forward: settle every object into its exact deterministic target.
    settle() {
      this._camT = 1;
      this._applyCamera(1);
      for (const [key, entry] of this.tileMeshes) {
        if (entry.target && entry.target.remove) this._removeTile(key);
        else if (entry.target) this._snapTo(entry, entry.target);
      }
      this._shake = 0;
    }

    /* ------------------------------------------------------------- frame */
    _frame(time) {
      if (this._disposed || !this._running) return;
      const dt = Math.min(0.05, this._lastTime ? (time - this._lastTime) / 1000 : 0.016);
      this._lastTime = time;

      // camera intro (authored ease, not cumulative lerp)
      if (this._camT < 1) {
        this._camT = Math.min(1, this._camT + dt / 1.4);
        this._applyCamera(this._camT);
      }
      // camera shake: low amplitude, decays, never affects raycast truth
      // (raycasting uses camera matrices pre-shake offset applied visually only)
      if (this._shake > 0.001 && !this.reducedMotion) {
        const s = this._shake;
        this.camera.position.x = this._baseCamPos.x + Math.sin(time * 0.09) * s;
        this.camera.position.y = this._baseCamPos.y + Math.cos(time * 0.11) * s * 0.6;
        this._shake *= Math.pow(0.02, dt);
      } else if (this._camT >= 1) {
        this.camera.position.copy(this._baseCamPos);
      }

      // critically damped spring toward targets (deterministic end state)
      const k = 90, c = 2 * Math.sqrt(k); // zeta = 1
      for (const [, entry] of this.tileMeshes) {
        const w = entry.target;
        if (!w) continue;
        const m = entry.mesh;
        const tx = w.pos[0], ty = w.pos[1] + (w.lift || 0), tz = w.pos[2];
        if (this.reducedMotion) {
          m.position.set(tx, ty, tz);
        } else {
          // semi-implicit euler spring
          entry.vel.x += (k * (tx - m.position.x) - c * entry.vel.x) * dt;
          entry.vel.y += (k * (ty - m.position.y) - c * entry.vel.y) * dt;
          entry.vel.z += (k * (tz - m.position.z) - c * entry.vel.z) * dt;
          m.position.x += entry.vel.x * dt;
          m.position.y += entry.vel.y * dt;
          m.position.z += entry.vel.z * dt;
        }
        // rotation
        const standing = w.standing;
        const tilt = standing ? (w.tilt || 0) : 0;
        const targetRotX = standing
          ? (w.faceUp === false ? -(Math.PI / 2 + tilt) : (Math.PI / 2 + (w.group === 'hand' ? tilt : -tilt)))
          : (w.faceUp === false ? Math.PI : 0);
        const targetRotY = w.rotY || 0;
        const rs = this.reducedMotion ? 1 : Math.min(1, dt * 10);
        m.rotation.x += (targetRotX - m.rotation.x) * rs;
        m.rotation.y += (targetRotY - m.rotation.y) * rs;
        if (w.remove && m.position.y > 6.5) this._removeTile(entry.key);
      }

      // steam drift (bounded, cosmetic; paused when hidden via pause())
      const still = this.reducedMotion || this._osReduced;
      if (this._steam && !still) this._updateSteam(time, dt);

      // window-light shimmer: slow, low-amplitude drift of the key light,
      // pendant and window glow (off with reduced motion or `ambience: static`)
      if (this.gfx.ambience === 'animated' && !still) {
        const s = time * 0.001;
        const n = Math.sin(s * 0.53) * 0.6 + Math.sin(s * 1.31 + 1.7) * 0.3 + Math.sin(s * 2.9 + 0.4) * 0.1;
        this.keyLight.intensity = this._keyBase * (1 + n * 0.035);
        this.pendant.intensity = this._pendantBase * (1 + Math.sin(s * 0.8 + 2.1) * 0.06);
        this.winGlow.material.opacity = this._winOpacity * (1 + n * 0.08);
      }

      // marker pulse
      const pulse = this.reducedMotion ? 1 : 1 + Math.sin(time * 0.005) * 0.08;
      for (const end of ['left', 'right']) {
        if (this.endMarkers[end].visible) this.endMarkers[end].scale.setScalar(pulse);
      }

      this._render(dt * 1000);
    }

    /* ------------------------------------------------- graphics settings */
    _pixelRatio() {
      const g = this.gfx;
      // × UIScale: the canvas sits inside the zoomed #app, so its backing store grows with the zoom.
      return Math.min(window.devicePixelRatio || 1, g.cap || 2) * ((window.UIScale && UIScale.value) || 1) * g.scale * this.adaptiveScale;
    }

    // Apply a resolved settings object (js/gfx.js resolve()) live.
    setGraphics(g) {
      if (!g) return;
      const THREE = this.THREE;
      const prev = this.gfx || {};
      this.gfx = g;
      // Shadows: map size, casters, and a material recompile for shadow state.
      const size = g.shadowMap || 0;
      this.renderer.shadowMap.enabled = size > 0;
      this.keyLight.castShadow = size > 0;
      if (size > 0 && this.keyLight.shadow.mapSize.x !== size) {
        this.keyLight.shadow.mapSize.set(size, size);
        if (this.keyLight.shadow.map) { this.keyLight.shadow.map.dispose(); this.keyLight.shadow.map = null; }
      }
      this.scene.traverse((o) => {
        if (o.userData.caster) o.castShadow = size > 0;
        if (o.material && (prev.shadowMap > 0) !== (size > 0)) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.needsUpdate = true; });
        }
      });
      // Surface detail: bump maps, clearcoat glaze, 2x face textures.
      const detailed = g.detail === 'detailed';
      for (const m of this._detailMats) {
        const b = m.userData.bump;
        m.bumpMap = detailed ? b.map : null;
        m.bumpScale = b.scale;
        m.needsUpdate = true;
      }
      for (const m of this._glazeMats) m.clearcoat = detailed ? m.userData.glaze : 0;
      for (const [, e] of this.tileMeshes) {
        e.faceMat.clearcoat = detailed ? 0.8 : 0;
        e.edgeMat.clearcoat = detailed ? 0.55 : 0;
        if (e.face && e.faceUpShown) this._setTileFace(e, e.face[0], e.face[1]);
      }
      // Steam density.
      if (this._steam && prev.particles !== g.particles) this._buildSteam();
      // Ambience: restore the base lighting when the shimmer stops.
      if (this._winOpacity === undefined) this._winOpacity = this.winGlow.material.opacity;
      this.keyLight.intensity = this._keyBase;
      this.pendant.intensity = this._pendantBase;
      this.winGlow.material.opacity = this._winOpacity;
      // Bloom highlights: legal-end markers and the selection ring exceed the
      // threshold; the window only brightens a little (UI sits over it).
      this._glow = g.bloom === 'on' ? 3.2 : 1;
      this.winGlow.material.color.set(0xffe9c4).multiplyScalar(g.bloom === 'on' ? 1.3 : 1);
      for (const end of ['left', 'right']) {
        if (this.endMarkers[end].visible) this.endMarkers[end].material.color.set(this.theme.accent).multiplyScalar(this._glow);
      }
      this.selRing.material.color.set(this.theme.accent).multiplyScalar(this._glow);
      this._applyReflections();
      this.adaptiveScale = 1;
      this._frames = [];
      this._disposePost();
      this.postKey = null; // rebuild the post chain on the next rendered frame
      const fps = document.getElementById('fps-meter');
      if (fps) {
        fps.classList.toggle('hidden', !g.showFps);
        if (g.showFps && !fps.textContent) fps.textContent = '… fps';
      }
      this.resize();
    }

    setQuality(name) { // legacy entry point: a bare preset name
      this.setGraphics(root.ChainDominoesGfx.resolve({ preset: name }, 'balanced'));
    }

    // Image-based lighting from three's RoomEnvironment (PMREM), so the glaze,
    // cup and wood pick up soft studio reflections.
    _applyReflections() {
      const on = this.gfx.reflections === 'on' && this.addons && this.addons.RoomEnvironment;
      if (on && !this._envTex) {
        try {
          const pmrem = new this.THREE.PMREMGenerator(this.renderer);
          const room = new this.addons.RoomEnvironment();
          this._envTex = pmrem.fromScene(room, 0.04).texture;
          room.dispose && room.dispose();
          pmrem.dispose();
        } catch (e) { this._envTex = null; }
      }
      const env = on ? this._envTex : null;
      if (this.scene.environment !== env) {
        this.scene.environment = env;
        // Felt barely reflects: its own, much weaker env map.
        for (const m of this._detailMats) {
          if (m.userData.envIntensity !== undefined) { m.envMap = env; m.envMapIntensity = m.userData.envIntensity; }
        }
        // Keep the overall exposure: the fill light steps down when IBL adds light.
        this.hemiLight.intensity = 0.55 * (this.theme.lightBoost || 1) * (env ? 0.6 : 1);
        this.scene.traverse((o) => {
          if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.needsUpdate = true; });
        });
      }
    }

    _setPostFailed(on) {
      if (this.postFailed === on) return;
      this.postFailed = on;
      if (this.onPostStatus) this.onPostStatus(on);
    }

    _postKey(w, h, pr) {
      const g = this.gfx;
      const msaaTarget = g.antialias === 'msaa' && !this._ctxAA;
      if (!(g.post || msaaTarget) || !this.addons) return 'none';
      return [g.ao, g.bloom, g.grade, g.antialias, w, h, pr].join('|');
    }

    _disposePost() {
      if (this.composer) {
        this.composer.passes.forEach(p => p.dispose && p.dispose());
        this.composer.dispose();
      }
      this.composer = null;
    }

    // RenderPass -> GTAO -> UnrealBloom -> grade -> OutputPass -> SMAA/FXAA.
    _buildPost(w, h, pr) {
      this._disposePost();
      if (this.postKey === 'none') return;
      const THREE = this.THREE, A = this.addons, g = this.gfx;
      try {
        const W = Math.max(2, Math.round(w * pr)), H = Math.max(2, Math.round(h * pr));
        const target = new THREE.WebGLRenderTarget(W, H, {
          type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
        });
        const composer = new A.EffectComposer(this.renderer, target);
        composer.setPixelRatio(pr);
        composer.setSize(w, h);
        composer.addPass(new A.RenderPass(this.scene, this.camera));
        if (g.ao !== 'off') {
          // Contact darkening under tiles, cup and rails; scaled to tile size.
          const ao = new A.GTAOPass(this.scene, this.camera, W, H);
          ao.output = A.GTAOPass.OUTPUT.Default;
          ao.blendIntensity = 0.75;
          ao.updateGtaoMaterial({ radius: 1.1, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
          ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
          composer.addPass(ao);
        }
        if (g.bloom === 'on') {
          // High threshold: only the window glow and glowing markers bloom.
          composer.addPass(new A.UnrealBloomPass(new THREE.Vector2(W, H), 0.45, 0.4, BLOOM_THRESHOLD));
        }
        if (g.grade === 'on') composer.addPass(new A.ShaderPass(GradeShader));
        composer.addPass(new A.OutputPass());
        if (g.antialias === 'smaa') composer.addPass(new A.SMAAPass(W, H));
        if (g.antialias === 'fxaa') composer.addPass(new A.FXAAPass());
        this.composer = composer;
        this._setPostFailed(false);
      } catch (e) {
        // Post is an enhancement: render directly if the chain cannot be built.
        this._disposePost();
        this._setPostFailed(true);
      }
    }

    // Adaptive resolution: average ~90 frames, step down 0.1 (min 0.6) when
    // slow (> 26 ms), back up 0.05 (max 1) when fast (< 14 ms).
    _adapt(ms) {
      const f = this._frames;
      f.push(ms);
      if (f.length < 90) return false;
      const avg = f.reduce((a, b) => a + b, 0) / f.length;
      f.length = 0;
      this.fps = 1000 / avg;
      const el = document.getElementById('fps-meter');
      if (el && !el.classList.contains('hidden')) {
        el.textContent = Math.round(this.fps) + ' fps · ' + Math.round(this.renderer.getPixelRatio() * 100) / 100 + '×';
      }
      if (!this.gfx.adaptive) return false;
      const before = this.adaptiveScale;
      if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
      else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
      return before !== this.adaptiveScale;
    }

    _render(ms) {
      if (this._adapt(ms)) this.resize();
      const size = this.renderer.getSize(this._size || (this._size = new this.THREE.Vector2()));
      const pr = this.renderer.getPixelRatio();
      const key = this._postKey(size.x, size.y, pr);
      if (key !== this.postKey) {
        this.postKey = key;
        this._buildPost(size.x, size.y, pr);
      }
      if (this.composer) {
        try { this.composer.render(ms / 1000); return; } catch (e) {
          this._disposePost();
          this.postKey = 'none';
          this._setPostFailed(true);
        }
      }
      this.renderer.render(this.scene, this.camera);
    }

    /** Drawing-buffer size and live stats for the Graphics panel summary. */
    graphicsInfo() {
      const size = this.renderer.getSize(new this.THREE.Vector2());
      const pr = this.renderer.getPixelRatio();
      if (size.x > 2 && size.y > 2) this._lastPixels = [Math.round(size.x * pr), Math.round(size.y * pr)];
      return {
        pixels: this._lastPixels || null, fps: Math.round(this.fps || 0),
        adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
        postFailed: !!this.postFailed, post: !!this.composer,
      };
    }

    /* --------------------------------------------------------- lifecycle */
    resize() {
      const parent = this.canvas.parentElement;
      const w = parent ? parent.clientWidth : window.innerWidth;
      const h = parent ? parent.clientHeight : window.innerHeight;
      this.renderer.setPixelRatio(this._pixelRatio());
      this.renderer.setSize(Math.max(2, w), Math.max(2, h), false);
      if (w > 2 && h > 2) this._lastPixels = [Math.round(w * this.renderer.getPixelRatio()), Math.round(h * this.renderer.getPixelRatio())];
      const aspect = w / Math.max(1, h);
      this.camera.aspect = aspect;
      // Portrait-fit framing: widen fov, then pull back until hand + chain fit.
      this.camera.fov = aspect < 0.9 ? 54 : FRAMING.fov;
      this.camera.updateProjectionMatrix();
      const prevScale = this._distScale;
      this._fitCamera();
      if (prevScale !== this._distScale) this._applyCamera(this._camT);
      this.camera.updateProjectionMatrix();
    }

    setReducedMotion(on) {
      this.reducedMotion = !!on;
      if (on) {
        this._camT = 1; this._applyCamera(1); this._shake = 0;
        this.keyLight.intensity = this._keyBase;
        this.pendant.intensity = this._pendantBase;
        this.winGlow.material.opacity = this._winOpacity;
      }
    }

    pause() { this._running = false; }
    resume() { this._running = true; this._lastTime = 0; }

    // Project a world position to CSS pixels (shared layout model for DOM).
    project(x, y, z) {
      const v = new this.THREE.Vector3(x, y, z).project(this.camera);
      const r = this.canvas.getBoundingClientRect();
      return { x: (v.x + 1) / 2 * r.width, y: (-v.y + 1) / 2 * r.height, visible: v.z < 1 };
    }

    tileScreenPos(key) {
      const e = this.tileMeshes.get(key);
      if (!e) return null;
      return this.project(e.mesh.position.x, e.mesh.position.y + 1, e.mesh.position.z);
    }

    dispose() {
      this._disposed = true;
      if (this._ro) this._ro.disconnect();
      this.renderer.setAnimationLoop(null);
      window.removeEventListener('resize', this._onResize);
      this._disposePost();
      if (this._envTex) this._envTex.dispose();
      if (this._dotTex) this._dotTex.dispose();
      for (const [key] of this.tileMeshes) this._removeTile(key);
      for (const [, tex] of this.texCache) tex.dispose();
      this.scene.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
            if (m.map) m.map.dispose();
            if (m.bumpMap) m.bumpMap.dispose();
            m.dispose();
          });
        }
      });
      // The next renderer reuses this canvas's WebGL context: reset the unpack
      // state left by canvas-texture uploads so its 3D dummy textures upload cleanly.
      try {
        const gl = this.renderer.getContext();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      } catch (e) { /* context lost: nothing to reset */ }
      this.renderer.dispose();
    }
  }

  root.ChainDominoesRender = { ChainRenderer, STEAM, FRAMING, TILE };
})(typeof self !== 'undefined' ? self : globalThis);
