/* Chain Dominoes — Three.js render layer.
 * Café tabletop with tactile ceramic dominoes. Consumes immutable rules
 * snapshots; never mutates game state. Exposes pick events, legal-target
 * previews, deterministic decor, quality tiers, reduced-motion support,
 * and settle() so skip/fast-forward lands in the exact logical end state.
 *
 * Rendering direction follows the spec's skill routing: authored camera,
 * procedural geometry/materials/animation/VFX, explicit tone mapping,
 * readable no-post baseline (no post-processing passes are used at all).
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

  const QUALITY = {
    low: { pixelRatio: 1, shadows: false, particles: 24, antialias: false, envDetail: 0.4, renderScale: 1 },
    medium: { pixelRatio: 1.5, shadows: true, particles: 60, antialias: true, envDetail: 0.7, renderScale: 1 },
    high: { pixelRatio: 2, shadows: true, particles: 120, antialias: true, envDetail: 1, renderScale: 1 },
  };

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

  function drawHalf(ctx, value, cx, cy, size, pipColor) {
    const u = size / 3.2;
    ctx.fillStyle = pipColor;
    for (const [px, py] of PIP_LAYOUTS[value]) {
      ctx.beginPath();
      ctx.arc(cx + px * u, cy + py * u, size * 0.13, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // One texture per (a,b) face, cached. Rounded face, divider, pips.
  function tileFaceTexture(a, b, theme, cache) {
    const key = a + '-' + b + '-' + theme.id;
    if (cache.has(key)) return cache.get(key);
    const S = 128;
    const c = makeCanvas(S, S * 2);
    const ctx = c.getContext('2d');
    const body = '#' + new root.THREE.Color(theme.tileBody).getHexString();
    ctx.fillStyle = body;
    ctx.fillRect(0, 0, c.width, c.height);
    // subtle ceramic gradient
    const grad = ctx.createLinearGradient(0, 0, 0, c.height);
    grad.addColorStop(0, 'rgba(255,255,255,0.10)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0.02)');
    grad.addColorStop(1, 'rgba(0,0,0,0.10)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, c.width, c.height);
    // divider
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(12, S); ctx.lineTo(S - 12, S); ctx.stroke();
    const pip = '#' + new root.THREE.Color(theme.pip).getHexString();
    drawHalf(ctx, a, S / 2, S / 2, S * 0.72, pip);
    drawHalf(ctx, b, S / 2, S * 1.5, S * 0.72, pip);
    const tex = new root.THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    tex.colorSpace = root.THREE.SRGBColorSpace;
    cache.set(key, tex);
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
      this.qualityName = opts.quality || 'medium';
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

      const q = QUALITY[this.qualityName];
      this.renderer = new THREE.WebGLRenderer({
        canvas, antialias: q.antialias, powerPreference: 'high-performance',
      });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
      this.renderer.shadowMap.enabled = q.shadows;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = this.theme.exposure || 1.05;

      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(this.theme.fog);
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

      this.renderer.setAnimationLoop((t) => this._frame(t));
    }

    /* ------------------------------------------------------------ camera */
    _applyCamera(t) {
      // Authored swoop: cubic ease from introFrom to camPos. Interruptible:
      // setting _camT = 1 snaps instantly (used by reduced motion / skip).
      const THREE = this.THREE;
      const ease = t >= 1 ? 1 : 1 - Math.pow(1 - t, 3);
      const lerp = (a, b) => a + (b - a) * ease;
      const p = FRAMING.introFrom, q = FRAMING.camPos;
      const ds = this._distScale || 1;
      this.camera.position.set(lerp(p[0], q[0]) * ds, lerp(p[1], q[1]) * ds, lerp(p[2], q[2]) * ds);
      this.camera.lookAt(FRAMING.camLook[0], FRAMING.camLook[1], FRAMING.camLook[2]);
      this._baseCamPos = this.camera.position.clone();
    }

    resetCamera() { this._camT = 1; this._applyCamera(1); }

    shake(amount) {
      if (this.reducedMotion) return;
      this._shake = Math.min(0.5, amount);
    }

    /* -------------------------------------------------------- environment */
    _buildEnvironment() {
      const THREE = this.THREE, t = this.theme;
      const q = QUALITY[this.qualityName];

      // Key light (window), warm
      const boost = this.theme.lightBoost || 1;
      const key = new THREE.DirectionalLight(0xfff2dd, 2.2 * boost);
      key.position.set(-18, 34, 18);
      key.castShadow = q.shadows;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.left = -36; key.shadow.camera.right = 36;
      key.shadow.camera.top = 36; key.shadow.camera.bottom = -36;
      key.shadow.bias = -0.0005;
      this.scene.add(key);
      this.keyLight = key;
      // Soft environment fill
      const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x3a2c1e, 0.55 * boost);
      this.scene.add(hemi);
      // Small warm café pendant
      const pendant = new THREE.PointLight(new THREE.Color(t.accent), 12, 60, 1.8);
      pendant.position.set(10, 22, -10);
      this.scene.add(pendant);

      // Table
      const table = new THREE.Mesh(
        new THREE.BoxGeometry(FRAMING.tableSize, 2.4, FRAMING.tableSize),
        new THREE.MeshStandardMaterial({ map: woodTexture(t), roughness: 0.75, metalness: 0.05 })
      );
      table.position.y = -1.2;
      table.receiveShadow = true;
      this.scene.add(table);

      // Felt playing mat with rounded look (thin box)
      const felt = new THREE.Mesh(
        new THREE.BoxGeometry(FRAMING.feltSize, 0.18, FRAMING.feltSize * 0.78),
        new THREE.MeshStandardMaterial({ map: feltTexture(t), roughness: 0.95, metalness: 0 })
      );
      felt.position.y = 0.09;
      felt.receiveShadow = true;
      this.scene.add(felt);

      // Café backdrop: wall plane + window glow + shelf (simple silhouettes)
      const wallMat = new THREE.MeshStandardMaterial({ color: t.wall, roughness: 1 });
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(200, 90), wallMat);
      wall.position.set(0, 30, -70);
      this.scene.add(wall);
      const winGlow = new THREE.Mesh(
        new THREE.PlaneGeometry(46, 34),
        new THREE.MeshBasicMaterial({ color: 0xffe9c4, transparent: true, opacity: 0.5 })
      );
      winGlow.position.set(-38, 34, -69);
      this.scene.add(winGlow);

      // Coffee cup + saucer + steam (procedural props, deterministic decor)
      this._buildCup(q);
      this._buildCrumbs(q);
    }

    _buildCup(q) {
      const THREE = this.THREE, t = this.theme;
      const cupMat = new THREE.MeshStandardMaterial({ color: t.cupColor, roughness: 0.35, metalness: 0.05 });
      const CUP = { x: -22.5, z: -9 }; // clear of the chain serpentine
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 1.7, 2.6, 24, 1, true), cupMat);
      cup.position.set(CUP.x, 1.4, CUP.z);
      cup.castShadow = q.shadows;
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
      const saucer = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 2.6, 0.35, 28), cupMat);
      saucer.position.set(CUP.x, 0.18, CUP.z);
      saucer.receiveShadow = true;
      this.scene.add(saucer);
      // handle: torus segment
      const handle = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.22, 10, 20, Math.PI), cupMat);
      handle.position.set(CUP.x + 2.15, 1.5, CUP.z);
      handle.rotation.z = -Math.PI / 2;
      this.scene.add(handle);

      // Steam: bounded CPU-updated points, cosmetic only, no raycast.
      const count = q.particles;
      const positions = new Float32Array(count * 3);
      const phases = new Float32Array(count);
      const rng = this._decorRng || (this._decorRng = this._seededRng('decor'));
      for (let i = 0; i < count; i++) {
        positions[i * 3] = CUP.x + (rng() - 0.5) * 1.6;
        positions[i * 3 + 1] = 2.6 + rng() * 5;
        positions[i * 3 + 2] = CUP.z + (rng() - 0.5) * 1.6;
        phases[i] = rng() * Math.PI * 2;
      }
      this._cupPos = CUP;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.PointsMaterial({
        color: 0xffffff, size: 0.55, transparent: true, opacity: 0.28, depthWrite: false,
      });
      const pts = new THREE.Points(geo, mat);
      pts.raycast = () => {}; // cosmetics never intercept raycasts
      pts.userData.phases = phases;
      this.scene.add(pts);
      this._steam = pts;
    }

    _buildCrumbs(q) {
      // Deterministic table scatter (sugar cubes), instanced.
      const THREE = this.THREE;
      const n = Math.floor(6 * q.envDetail) + 2;
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
      inst.castShadow = q.shadows;
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
      const edgeMat = new THREE.MeshStandardMaterial({ color: this.theme.tileEdge, roughness: 0.4, metalness: 0.02 });
      const faceMat = new THREE.MeshStandardMaterial({ color: this.theme.tileBody, roughness: 0.35, metalness: 0.02 });
      const backMat = new THREE.MeshStandardMaterial({
        map: tileBackTexture(this.theme, this.texCache), roughness: 0.5,
      });
      // ExtrudeGeometry groups: 0 = front/back faces, 1 = side walls
      const mesh = new THREE.Mesh(makeTileGeometry(), [faceMat, edgeMat]);
      mesh.castShadow = QUALITY[this.qualityName].shadows;
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
      const tex = tileFaceTexture(a, b, this.theme, this.texCache);
      if (entry.faceMat.map !== tex) {
        entry.faceMat.map = tex;
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
          marker.material.color = new THREE.Color(this.theme.accent);
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
      if (this._steam && !this.reducedMotion) {
        const pos = this._steam.geometry.attributes.position;
        const phases = this._steam.userData.phases;
        for (let i = 0; i < pos.count; i++) {
          let y = pos.getY(i) + dt * 0.9;
          if (y > 8) y = 2.6;
          pos.setY(i, y);
          pos.setX(i, (this._cupPos ? this._cupPos.x : -19) + Math.sin(time * 0.001 + phases[i]) * 0.9);
        }
        pos.needsUpdate = true;
      }

      // marker pulse
      const pulse = this.reducedMotion ? 1 : 1 + Math.sin(time * 0.005) * 0.08;
      for (const end of ['left', 'right']) {
        if (this.endMarkers[end].visible) this.endMarkers[end].scale.setScalar(pulse);
      }

      this.renderer.render(this.scene, this.camera);
    }

    /* --------------------------------------------------------- lifecycle */
    resize() {
      const parent = this.canvas.parentElement;
      const w = parent ? parent.clientWidth : window.innerWidth;
      const h = parent ? parent.clientHeight : window.innerHeight;
      const q = QUALITY[this.qualityName];
      const scale = q.renderScale;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio) * scale);
      this.renderer.setSize(Math.max(2, w), Math.max(2, h), false);
      const aspect = w / Math.max(1, h);
      this.camera.aspect = aspect;
      // Portrait-fit framing: widen fov and pull back so the table fits.
      this.camera.fov = aspect < 0.9 ? 54 : FRAMING.fov;
      const prevScale = this._distScale;
      this._distScale = aspect < 0.9 ? 1.22 : (aspect < 1.3 ? 1.08 : 1);
      if (prevScale !== this._distScale) this._applyCamera(this._camT);
      this.camera.updateProjectionMatrix();
    }

    setQuality(name) {
      if (!QUALITY[name] || name === this.qualityName) return;
      this.qualityName = name;
      const q = QUALITY[name];
      this.renderer.shadowMap.enabled = q.shadows;
      this.keyLight.castShadow = q.shadows;
      this.resize();
    }

    setReducedMotion(on) {
      this.reducedMotion = !!on;
      if (on) { this._camT = 1; this._applyCamera(1); this._shake = 0; }
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
      for (const [key] of this.tileMeshes) this._removeTile(key);
      for (const [, tex] of this.texCache) tex.dispose();
      this.scene.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
            if (m.map) m.map.dispose();
            m.dispose();
          });
        }
      });
      this.renderer.dispose();
    }
  }

  root.ChainDominoesRender = { ChainRenderer, QUALITY, FRAMING, TILE };
})(typeof self !== 'undefined' ? self : globalThis);
