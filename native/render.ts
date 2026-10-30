// The café tabletop on starhermit:scene, as the browser build's
// js/render3d.js drew it: the wooden table and the felt playing mat with its
// leather band, the café wall with its wainscot, the window glow and its
// mullions, the coffee cup with crema and rising steam, sugar cubes, the
// ceramic dominoes (rounded, extruded, a canvas face per value pair with
// drilled pips, a grooved divider and a brass spinner pin; clearcoat glaze
// and bump-mapped pips when detailed), the chain as a serpentine, the
// player's hand standing at the front, the opponents' face-down rows at
// their edges, the boneyard stack, the end markers with their value labels,
// the ghost preview and the selection ring. Tiles move on a critically
// damped spring (settled at once with reduced motion or a skip); the camera
// swoops in at a match's start, can shake on a round's end, resets, and
// toggles a top-down view. The key light, pendant and window glow shimmer
// gently on the higher graphics levels.
//
// The camera frames the table into the play area the HUD leaves
// (setViewOffset), pulled back until the hand arc and the chain area fit, as
// the browser build fit them into its canvas.
import {
  ACESFilmicToneMapping, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CircleGeometry, Color, CylinderGeometry,
  DirectionalLight, ExtrudeGeometry, Fog, Group, HemisphereLight, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, PMREMGenerator, PerspectiveCamera, PlaneGeometry,
  OrthographicCamera, PointLight, Points, PointsMaterial, Raycaster, RepeatWrapping, RingGeometry, RoomEnvironment, SRGBColorSpace, Shape,
  Sprite, SpriteMaterial, TorusGeometry, Vector2, Vector3, pointerToNdc, renderer, scene,
  type Material, type Object3D, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import type { Theme, View } from "./classic.ts";
import type { Look } from "./quality.ts";

const PI = Math.PI;
// Framing constants (as js/render3d.js).
const FRAMING = { fov: 38, camPos: [0, 26, 30], camLook: [0, 0, -2], introFrom: [0, 40, 52], tableSize: 72, feltSize: 56 };
const TOP_DOWN = [0, 62, 0.01];
const TILE = { w: 2.0, l: 4.0, h: 0.85, gap: 0.35 };
const CHAIN = { rowAdvance: 5.2, maxRow: 30.0 };
/** The RoomEnvironment's strength (the browser build's scene.environmentIntensity). */
const ENV_INTENSITY = 0.3;

const camera = new PerspectiveCamera(FRAMING.fov, 16 / 9, 0.5, 300);
renderer.toneMapping = ACESFilmicToneMapping;

let theme: Theme | null = null;
let look: Look | null = null;
let reducedMotion = false;
let time = 0;

const hex = (n: number): string => "#" + n.toString(16).padStart(6, "0");
function seededRng(label: string): () => number {
  let s = 2166136261;
  const str = (theme ? theme.id : "x") + ":" + label;
  for (let i = 0; i < str.length; i++) { s ^= str.charCodeAt(i); s = Math.imul(s, 16777619); }
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- canvas textures
const PIP_LAYOUTS: Record<number, [number, number][]> = {
  0: [], 1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]], 5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
};
function arc(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath(); ctx.arc(x, y, r, 0, PI * 2); ctx.fill();
}
/** Drilled pips: a soft dark lip, a lit lower rim and the pip colour in the well; `bump` draws a height map. */
function drawHalf(ctx: OffscreenCanvasRenderingContext2D, value: number, cx: number, cy: number, size: number, pipColor: string, bump: boolean): void {
  const u = size / 3.2, r = size * 0.13;
  for (const [px, py] of PIP_LAYOUTS[value] ?? []) {
    const x = cx + px * u, y = cy + py * u;
    if (bump) {
      const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 1.15);
      g.addColorStop(0, "#000"); g.addColorStop(0.75, "#202020"); g.addColorStop(1, "rgba(128,128,128,0)");
      ctx.fillStyle = g; arc(ctx, x, y, r * 1.15);
      continue;
    }
    ctx.fillStyle = "rgba(255,255,255,0.55)"; arc(ctx, x + r * 0.12, y + r * 0.14, r * 1.08);
    ctx.fillStyle = "rgba(0,0,0,0.28)"; arc(ctx, x - r * 0.08, y - r * 0.1, r * 1.06);
    ctx.fillStyle = pipColor; arc(ctx, x, y, r);
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, 0, x, y, r);
    g.addColorStop(0, "rgba(0,0,0,0.35)"); g.addColorStop(1, "rgba(255,255,255,0.08)");
    ctx.fillStyle = g; arc(ctx, x, y, r);
  }
}

/** A grey height canvas as a bump map (the page's CanvasTexture: no colour space). */
function bumpTexture(src: OffscreenCanvas, wrap: boolean): Texture {
  const tex = new CanvasTexture(src);
  if (wrap) tex.wrapS = tex.wrapT = RepeatWrapping;
  return tex;
}

const faceCache = new Map<string, Texture>();
/** One texture per (a, b) face, cached: ceramic face, grooved divider with a brass spinner pin, drilled pips. */
function tileFaceTexture(a: number, b: number, normal: boolean): Texture {
  const t = theme!;
  const S = look?.budget.faceTexture ?? 128, k = S / 128;
  const key = `${a}-${b}-${t.id}-${normal ? "n" : "c"}-${S}`;
  const hit = faceCache.get(key);
  if (hit) return hit;
  const c = new OffscreenCanvas(S, S * 2);
  const ctx = c.getContext("2d");
  if (normal) {
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = "#303030"; ctx.lineWidth = 4 * k;
    ctx.beginPath(); ctx.moveTo(12 * k, S); ctx.lineTo(S - 12 * k, S); ctx.stroke();
    drawHalf(ctx, a, S / 2, S / 2, S * 0.72, "#000", true);
    drawHalf(ctx, b, S / 2, S * 1.5, S * 0.72, "#000", true);
    const tex = bumpTexture(c, false);
    tex.anisotropy = look?.detailed ? 8 : 4;
    faceCache.set(key, tex);
    return tex;
  }
  ctx.fillStyle = hex(t.tileBody);
  ctx.fillRect(0, 0, c.width, c.height);
  const grad = ctx.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, "rgba(255,255,255,0.12)"); grad.addColorStop(0.5, "rgba(0,0,0,0.0)"); grad.addColorStop(1, "rgba(0,0,0,0.10)");
  ctx.fillStyle = grad; ctx.fillRect(0, 0, c.width, c.height);
  const edge = ctx.createRadialGradient(S / 2, S, S * 0.6, S / 2, S, S * 1.25);
  edge.addColorStop(0, "rgba(0,0,0,0)"); edge.addColorStop(1, "rgba(60,40,20,0.10)");
  ctx.fillStyle = edge; ctx.fillRect(0, 0, c.width, c.height);
  ctx.lineWidth = 3 * k;
  ctx.strokeStyle = "rgba(0,0,0,0.42)";
  ctx.beginPath(); ctx.moveTo(12 * k, S - 1 * k); ctx.lineTo(S - 12 * k, S - 1 * k); ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1.5 * k;
  ctx.beginPath(); ctx.moveTo(12 * k, S + 2 * k); ctx.lineTo(S - 12 * k, S + 2 * k); ctx.stroke();
  const pin = ctx.createRadialGradient(S / 2 - 2 * k, S - 2 * k, 0, S / 2, S, 6 * k);
  pin.addColorStop(0, "#fff3c4"); pin.addColorStop(0.45, "#caa24a"); pin.addColorStop(1, "#6d5220");
  ctx.fillStyle = pin; arc(ctx, S / 2, S, 5.5 * k);
  const pip = hex(t.pip);
  drawHalf(ctx, a, S / 2, S / 2, S * 0.72, pip, false);
  drawHalf(ctx, b, S / 2, S * 1.5, S * 0.72, pip, false);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = look?.detailed ? 8 : 4;
  faceCache.set(key, tex);
  return tex;
}

function softDotTexture(): Texture {
  const c = new OffscreenCanvas(64, 64);
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.4, "rgba(255,255,255,0.45)"); g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
/** Grey fibre noise (the felt's bump in the browser build). */
function noiseTexture(size: number, seedStart: number, dots: number, repeat: number): Texture {
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#808080"; ctx.fillRect(0, 0, size, size);
  let seed = seedStart;
  const rnd = (): number => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < dots; i++) {
    const v = Math.floor(90 + rnd() * 80);
    ctx.strokeStyle = `rgb(${v},${v},${v})`;
    ctx.lineWidth = 0.6 + rnd();
    const x = rnd() * size, y = rnd() * size, a = rnd() * PI * 2, l = 1 + rnd() * 3;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
  }
  const tex = bumpTexture(c, true);
  tex.repeat.set(repeat, repeat);
  return tex;
}
function woodCanvas(): OffscreenCanvas {
  const S = 512;
  const c = new OffscreenCanvas(S, S);
  const ctx = c.getContext("2d");
  ctx.fillStyle = hex(theme!.table);
  ctx.fillRect(0, 0, S, S);
  let seed = 12345;
  const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 90; i++) {
    const y = rnd() * S;
    const dark = rnd() > 0.5;
    ctx.strokeStyle = dark ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1 + rnd() * 3;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= S; x += 32) ctx.lineTo(x, y + Math.sin(x * 0.02 + i) * 4 * rnd());
    ctx.stroke();
  }
  return c;
}
function woodTexture(c: OffscreenCanvas): Texture {
  const tex = new CanvasTexture(c);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(2, 2);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
/** Café wall: tongue-and-groove wainscot below a plaster band. */
function wallTexture(): Texture {
  const W = 512, H = 256;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = hex(theme!.wall);
  ctx.fillRect(0, 0, W, H);
  const rail = H * 0.62;
  let seed = 777;
  const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = rnd() > 0.5 ? "rgba(255,255,255,0.025)" : "rgba(0,0,0,0.03)";
    arc(ctx, rnd() * W, rnd() * rail, 4 + rnd() * 14);
  }
  ctx.fillStyle = "rgba(0,0,0,0.16)";
  ctx.fillRect(0, rail, W, H - rail);
  for (let x = 0; x < W; x += 32) {
    ctx.fillStyle = "rgba(0,0,0,0.22)"; ctx.fillRect(x, rail, 2, H - rail);
    ctx.fillStyle = "rgba(255,255,255,0.05)"; ctx.fillRect(x + 2, rail, 1, H - rail);
  }
  ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.fillRect(0, rail - 6, W, 8);
  ctx.fillStyle = "rgba(255,255,255,0.08)"; ctx.fillRect(0, rail - 6, W, 2);
  const tex = new CanvasTexture(c);
  tex.wrapS = RepeatWrapping;
  tex.repeat.set(3, 1);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
function feltTexture(): Texture {
  const S = 256;
  const c = new OffscreenCanvas(S, S);
  const ctx = c.getContext("2d");
  ctx.fillStyle = hex(theme!.felt);
  ctx.fillRect(0, 0, S, S);
  let seed = 999;
  const rnd = (): number => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 3000; i++) {
    ctx.fillStyle = rnd() > 0.5 ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.03)";
    ctx.fillRect(rnd() * S, rnd() * S, 1.5, 1.5);
  }
  const tex = new CanvasTexture(c);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
const labelCache = new Map<string, Texture>();
function labelTexture(text: string): Texture {
  const hit = labelCache.get(text);
  if (hit) return hit;
  const c = new OffscreenCanvas(128, 128);
  const ctx = c.getContext("2d");
  ctx.font = "bold 84px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, 64, 70);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  labelCache.set(text, tex);
  return tex;
}

// ---------------------------------------------------------------- tile geometry
function roundedRectShape(w: number, l: number, r: number): Shape {
  const s = new Shape();
  const x = -w / 2, y = -l / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + l - r); s.quadraticCurveTo(x + w, y + l, x + w - r, y + l);
  s.lineTo(x + r, y + l); s.quadraticCurveTo(x, y + l, x, y + l - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
const geoCache = new Map<string, BufferGeometry>();
/** The tile: a rounded rectangle extruded and bevelled, lying flat, face up, its UVs normalized to the cap. */
function tileGeometry(curve: number, bevel: number): BufferGeometry {
  const key = `${curve}:${bevel}`;
  const hit = geoCache.get(key);
  if (hit) return hit;
  const geo = new ExtrudeGeometry(roundedRectShape(TILE.w, TILE.l, 0.32), {
    depth: TILE.h, bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.1, bevelSegments: bevel, curveSegments: curve,
  });
  // ExtrudeGeometry UVs are raw shape coordinates: normalized to [0,1] so the face texture maps onto the cap.
  const pos = geo.getAttribute("position")!.array as Float32Array;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    minX = Math.min(minX, pos[i]!); maxX = Math.max(maxX, pos[i]!);
    minY = Math.min(minY, pos[i + 1]!); maxY = Math.max(maxY, pos[i + 1]!);
  }
  const uvAttr = geo.getAttribute("uv")!;
  const uv = uvAttr.array as Float32Array;
  for (let i = 0; i < uv.length; i += 2) {
    uv[i] = (uv[i]! - minX) / (maxX - minX);
    uv[i + 1] = (uv[i + 1]! - minY) / (maxY - minY);
  }
  uvAttr.needsUpdate = true;
  geo.rotateX(-PI / 2);
  geo.translate(0, TILE.h / 2 + 0.1, 0);
  geoCache.set(key, geo);
  return geo;
}

// ---------------------------------------------------------------- lights
const keyLight = new DirectionalLight(0xfff2dd, 1);
keyLight.position.set(-18, 34, 18);
{
  const sc = keyLight.shadow.camera as OrthographicCamera;
  sc.left = -31; sc.right = 31; sc.top = 27; sc.bottom = -27; sc.near = 10; sc.far = 90;
  sc.updateProjectionMatrix();
}
keyLight.shadow.bias = -0.0004;
keyLight.shadow.normalBias = 0.03;
keyLight.shadow.radius = 3;
const hemi = new HemisphereLight(0xcfe4ff, 0x3a2c1e, 1);
const pendant = new PointLight(0xffffff, 1, 60, 1.8);
pendant.position.set(10, 22, -10);
scene.add(keyLight, keyLight.target, hemi, pendant);
scene.fog = new Fog(0x2a211a, 70, 160);
let keyBase = 0, pendantBase = 0, winOpacity = 0.5;

// ---------------------------------------------------------------- the world
let world: Group | null = null;
let winGlow: Mesh | null = null;
let steam: Points | null = null;
let steamPhases: Float32Array | null = null;
let steamCount = 0;
let dotTex: Texture | null = null;
const CUP = { x: -22.5, z: -9 };
let endMarkers: Record<"left" | "right", Mesh> | null = null;
let endLabels: Record<"left" | "right", Sprite> | null = null;
let ghost: Mesh | null = null;
let selRing: Mesh | null = null;
let glow = 1;

interface LitParams { color?: number | Color; map?: Texture | null; bumpMap?: Texture | null; bumpScale?: number; roughness?: number; metalness?: number; clearcoat?: number; clearcoatRoughness?: number }
/** Lit material for the level's budget: Lambert on Low, Standard on Balanced, Physical glaze (where `physical`) above. */
function lit(p: LitParams, physical = false): Material {
  const kind = look?.budget.material ?? "standard";
  const base = { color: p.color ?? 0xffffff, map: p.map ?? null, bumpMap: look?.detailed ? p.bumpMap ?? null : null, bumpScale: p.bumpScale ?? 1 };
  if (kind === "lambert") return new MeshLambertMaterial(base);
  const std = { ...base, roughness: p.roughness ?? 1, metalness: p.metalness ?? 0 };
  if (physical && kind === "physical") return new MeshPhysicalMaterial({ ...std, clearcoat: look?.detailed ? p.clearcoat ?? 0 : 0, clearcoatRoughness: p.clearcoatRoughness ?? 0 });
  return new MeshStandardMaterial(std);
}

let envTex: Texture | null = null;
function build(): void {
  if (!theme || !look) return;
  const t = theme;
  if (world) scene.remove(world);
  const g = new Group();
  world = g;
  scene.add(g);
  const boost = t.lightBoost || 1;
  // the page's three r182 intensities (engine.minor 28 light units)
  keyLight.intensity = keyBase = 2.2 * boost;
  hemi.intensity = 0.55 * boost * (look.reflections ? 0.6 : 1);
  pendant.color.set(t.accent);
  pendant.intensity = pendantBase = 12;
  renderer.toneMappingExposure = t.exposure || 1.05;
  scene.background = new Color(t.fog);
  (scene.fog as Fog).color.set(t.fog);

  // table
  const wood = woodCanvas();
  const woodMap = woodTexture(wood);
  const table = new Mesh(new BoxGeometry(FRAMING.tableSize, 2.4, FRAMING.tableSize), lit({ map: woodMap, bumpMap: woodMap, bumpScale: 1.2, roughness: 0.62, metalness: 0.05 }));
  table.position.y = -1.2;
  table.receiveShadow = true;
  g.add(table);
  // felt
  const feltMat = lit({ map: feltTexture(), bumpMap: look.detailed ? noiseTexture(256, 4242, 5000, 6) : null, bumpScale: 1.6, roughness: 0.95 });
  const felt = new Mesh(new BoxGeometry(FRAMING.feltSize, 0.18, FRAMING.feltSize * 0.78), feltMat);
  felt.position.y = 0.09;
  felt.receiveShadow = true;
  g.add(felt);
  // leather band
  const bandMat = lit({ color: new Color(t.felt).lerp(new Color(0x1a120b), 0.72), roughness: 0.48 });
  const fw = FRAMING.feltSize, fd = FRAMING.feltSize * 0.78, bw = 0.9;
  for (const [w, d, x, z] of [[fw + bw * 2, bw, 0, -fd / 2 - bw / 2], [fw + bw * 2, bw, 0, fd / 2 + bw / 2], [bw, fd, -fw / 2 - bw / 2, 0], [bw, fd, fw / 2 + bw / 2, 0]] as const) {
    const m = new Mesh(new BoxGeometry(w, 0.34, d), bandMat);
    m.position.set(x, 0.17, z);
    m.receiveShadow = true;
    g.add(m);
  }
  // café backdrop
  const wall = new Mesh(new PlaneGeometry(200, 90), lit({ map: wallTexture(), roughness: 1 }));
  wall.position.set(0, 30, -70);
  g.add(wall);
  winGlow = new Mesh(new PlaneGeometry(46, 34), new MeshBasicMaterial({ color: new Color(0xffe9c4).multiplyScalar(look.bloom ? 1.3 : 1), transparent: true, opacity: 0.5 }));
  winOpacity = 0.5;
  winGlow.position.set(-38, 34, -69);
  g.add(winGlow);
  const barMat = lit({ color: new Color(t.wall).multiplyScalar(0.55), roughness: 0.9 });
  for (const [w, h, x, y] of [[1.2, 34, -38, 34], [46, 1.2, -38, 34], [47.5, 1.6, -38, 17.2], [47.5, 1.6, -38, 50.8]] as const) {
    const bar = new Mesh(new PlaneGeometry(w, h), barMat);
    bar.position.set(x, y, -68.8);
    g.add(bar);
  }
  buildCup(g);
  buildCrumbs(g);
  buildMarkers(g);

  // shadows, reflections
  const shadows = look.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  keyLight.castShadow = shadows;
  if (shadows) keyLight.shadow.mapSize = look.shadows;
  if (look.reflections) {
    if (!envTex) {
      try { const envRoom = new RoomEnvironment(renderer); envRoom.position.y = 0; /* the page's three (pre-r183) builds the room at the origin */ envTex = new PMREMGenerator(renderer).fromScene(envRoom, 0.04).texture; }
      catch (e) { console.warn("environment:", e instanceof Error ? e.message : String(e)); }
    }
    scene.environment = envTex;
    scene.environmentIntensity = ENV_INTENSITY;
  } else scene.environment = null;
  // Felt barely reflects: its own, much weaker env map (as the page).
  if (feltMat instanceof MeshStandardMaterial) { feltMat.envMap = look.reflections ? envTex : null; feltMat.envMapIntensity = 0.08; }
  glow = look.bloom ? 3.2 : 1;
  (selRing!.material as MeshBasicMaterial).color.set(t.accent).multiplyScalar(glow);

  // tiles again in the new look
  for (const key of [...tiles.keys()]) removeTile(key);
  if (lastView) sync(lastView, true);
}

function buildCup(g: Group): void {
  const t = theme!;
  const cupMat = lit({ color: t.cupColor, roughness: 0.3, metalness: 0.02, clearcoat: 0.9, clearcoatRoughness: 0.12 }, true);
  const cup = new Mesh(new CylinderGeometry(2.1, 1.7, 2.6, 24, 1, true), cupMat);
  cup.position.set(CUP.x, 1.4, CUP.z);
  cup.castShadow = true;
  g.add(cup);
  const bottom = new Mesh(new CircleGeometry(1.7, 24), cupMat);
  bottom.rotation.x = -PI / 2;
  bottom.position.set(CUP.x, 0.12, CUP.z);
  g.add(bottom);
  const coffee = new Mesh(new CircleGeometry(1.9, 24), new MeshStandardMaterial({ color: 0x2a180e, roughness: 0.25 }));
  coffee.rotation.x = -PI / 2;
  coffee.position.set(CUP.x, 2.55, CUP.z);
  g.add(coffee);
  const crema = new Mesh(new RingGeometry(1.35, 1.9, 32), new MeshStandardMaterial({ color: 0x8a5a32, roughness: 0.4, transparent: true, opacity: 0.8 }));
  crema.rotation.x = -PI / 2;
  crema.position.set(CUP.x, 2.56, CUP.z);
  g.add(crema);
  const saucer = new Mesh(new CylinderGeometry(3.4, 2.6, 0.35, 28), cupMat);
  saucer.position.set(CUP.x, 0.18, CUP.z);
  saucer.receiveShadow = true;
  g.add(saucer);
  const handle = new Mesh(new TorusGeometry(1.1, 0.22, 10, 20, PI), cupMat);
  handle.position.set(CUP.x + 2.15, 1.5, CUP.z);
  handle.rotation.z = -PI / 2;
  g.add(handle);
  buildSteam(g);
}

/** Steam: soft points that rise, sway and fade (cosmetic only). */
function buildSteam(g: Group): void {
  const count = look!.budget.steam;
  steamCount = count;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 4);
  steamPhases = new Float32Array(count);
  const rng = seededRng("steam");
  for (let i = 0; i < count; i++) {
    positions[i * 3] = CUP.x + (rng() - 0.5) * 1.6;
    positions[i * 3 + 1] = 2.6 + rng() * 5.4;
    positions[i * 3 + 2] = CUP.z + (rng() - 0.5) * 1.6;
    steamPhases[i] = rng() * PI * 2;
    colors[i * 4] = colors[i * 4 + 1] = colors[i * 4 + 2] = 1;
    colors[i * 4 + 3] = 1;
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(positions, 3));
  geo.setAttribute("color", new BufferAttribute(colors, 4));
  if (!dotTex) dotTex = softDotTexture();
  const mat = new PointsMaterial({
    size: count > 40 ? 0.9 : 1.1, map: dotTex, vertexColors: true,
    transparent: true, opacity: count > 40 ? 0.22 : 0.3, depthWrite: false,
  });
  steam = new Points(geo, mat);
  g.add(steam);
  updateSteam(0, 0);
}
function updateSteam(tm: number, dt: number): void {
  if (!steam || !steamPhases) return;
  const posA = steam.geometry.getAttribute("position")!;
  const colA = steam.geometry.getAttribute("color")!;
  const pos = posA.array as Float32Array, col = colA.array as Float32Array;
  for (let i = 0; i < steamCount; i++) {
    let y = pos[i * 3 + 1]! + dt * 0.9;
    if (y > 8) y = 2.6;
    pos[i * 3 + 1] = y;
    const rise = (y - 2.6) / 5.4;
    pos[i * 3] = CUP.x + Math.sin(tm * 1 + steamPhases[i]!) * (0.4 + rise * 0.8);
    col[i * 4 + 3] = Math.sin(PI * Math.min(1, rise)) * 0.9 + 0.1;
  }
  posA.needsUpdate = true;
  colA.needsUpdate = true;
}

function buildCrumbs(g: Group): void {
  const n = 8;
  const rng = seededRng("decor");
  const inst = new InstancedMesh(new BoxGeometry(0.5, 0.5, 0.5), new MeshStandardMaterial({ color: 0xf5f0e2, roughness: 0.9 }), n);
  const m = new Matrix4();
  for (let i = 0; i < n; i++) {
    const x = 18 + rng() * 6, z = -17 + rng() * 5;
    m.makeRotationY(rng() * PI);
    m.setPosition(x, 0.35, z);
    inst.setMatrixAt(i, m);
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.castShadow = true;
  g.add(inst);
}

function buildMarkers(g: Group): void {
  const t = theme!;
  const mk = (): Mesh => {
    const ring = new Mesh(new TorusGeometry(1.8, 0.24, 10, 32), new MeshBasicMaterial({ color: t.accent2, transparent: true, opacity: 0.9 }));
    ring.rotation.x = -PI / 2;
    ring.visible = false;
    g.add(ring);
    return ring;
  };
  endMarkers = { left: mk(), right: mk() };
  const lbl = (): Sprite => {
    const sp = new Sprite(new SpriteMaterial({ map: labelTexture("0"), transparent: true, depthTest: false }));
    sp.scale.set(2.4, 2.4, 1);
    sp.visible = false;
    g.add(sp);
    return sp;
  };
  endLabels = { left: lbl(), right: lbl() };
  ghost = new Mesh(tileGeometry(6, 2), new MeshBasicMaterial({ color: t.accent, transparent: true, opacity: 0.35, depthWrite: false }));
  ghost.visible = false;
  g.add(ghost);
  selRing = new Mesh(new TorusGeometry(1.5, 0.14, 10, 32), new MeshBasicMaterial({ color: t.accent, transparent: true, opacity: 0.95 }));
  selRing.rotation.x = -PI / 2;
  selRing.visible = false;
  g.add(selRing);
}

// ---------------------------------------------------------------- tiles
interface Target { pos: [number, number, number]; rotY?: number; tilt?: number; standing?: boolean; faceUp: boolean; face?: [number, number] | null; group: "chain" | "hand" | "opp" | "bone" | "out"; lift?: number; remove?: boolean }
interface Entry { key: string; mesh: Mesh<Material[]>; faceMat: Material; edgeMat: Material; vel: Vector3; target: Target; face: [number, number] | null; removing: boolean }
const tiles = new Map<string, Entry>();
let lastView: View | null = null;
let selectedKey: string | null = null;
let hovered: Pick | null = null;

function chainSlot(i: number): { x: number; z: number } {
  const adv = TILE.w + TILE.gap;
  const perRow = Math.floor(CHAIN.maxRow / adv);
  const row = Math.floor(i / perRow);
  const idx = i % perRow;
  const dir = row % 2 === 0 ? 1 : -1;
  const xx = dir === 1 ? idx : perRow - 1 - idx;
  return { x: -CHAIN.maxRow / 2 + xx * adv + adv / 2, z: -14 + row * CHAIN.rowAdvance };
}

function makeTile(key: string, w: Target): Entry {
  const t = theme!;
  const b = look!.budget;
  const edgeMat = lit({ color: t.tileEdge, roughness: 0.4, metalness: 0.02, clearcoat: 0.55, clearcoatRoughness: 0.22 }, true);
  const faceMat = lit({ color: w.faceUp ? t.tileBody : t.tileEdge, roughness: 0.35, metalness: 0.02, clearcoat: 0.8, clearcoatRoughness: 0.16 }, true);
  const mesh = new Mesh(tileGeometry(b.tileCurve, b.tileBevel), [faceMat, edgeMat]);
  mesh.castShadow = look!.shadows > 0;
  mesh.receiveShadow = true;
  world!.add(mesh);
  return { key, mesh, faceMat, edgeMat, vel: new Vector3(), target: w, face: null, removing: false };
}
function setTileFace(e: Entry, a: number, b: number): void {
  if (e.face && e.face[0] === a && e.face[1] === b) return;
  e.face = [a, b];
  const m = e.faceMat as MeshStandardMaterial;
  m.map = tileFaceTexture(a, b, false);
  m.color.set(0xffffff);
  m.bumpMap = look!.detailed ? tileFaceTexture(a, b, true) : null;
  m.bumpScale = 2.5;
}
function removeTile(key: string): void {
  const e = tiles.get(key);
  if (!e) return;
  world?.remove(e.mesh);
  tiles.delete(key);
}
function snapTo(e: Entry, w: Target): void {
  e.mesh.position.set(w.pos[0], w.pos[1] + (w.lift || 0), w.pos[2]);
  const r = targetRotation(w);
  e.mesh.rotation.set(r.x, r.y, 0, "YXZ");
  e.vel.set(0, 0, 0);
}
function targetRotation(w: Target): { x: number; y: number } {
  const tilt = w.standing ? (w.tilt || 0) : 0;
  const x = w.standing
    ? (w.faceUp === false ? -(PI / 2 + tilt) : (PI / 2 + (w.group === "hand" ? tilt : -tilt)))
    : (w.faceUp === false ? PI : 0);
  return { x, y: w.rotY || 0 };
}

/** Sync from an immutable view (instant settles at once). */
export function sync(view: View, instant: boolean): void {
  lastView = view;
  if (!world || !theme) return;
  const want = new Map<string, Target>();
  view.chain.forEach((c, i) => {
    const slot = chainSlot(i);
    want.set(String(c.id), { pos: [slot.x, 0.2, slot.z], rotY: c.double ? PI / 2 : 0, faceUp: true, face: [c.a, c.b], group: "chain" });
  });
  const my = view.myHand || [];
  const spread = Math.min(24, my.length * 2.6);
  my.forEach((id, i) => {
    const tt = my.length <= 1 ? 0 : (i / (my.length - 1)) - 0.5;
    want.set(String(id), { pos: [tt * spread, 0.2, 15.5 - Math.abs(tt) * 2.0], rotY: 0, tilt: -0.28, standing: true, faceUp: true, face: view.tileFaces[id] ?? null, group: "hand" });
  });
  (view.opponents || []).forEach((opp, oi) => {
    const p = view.opponentPositions[oi];
    if (!p) return;
    for (let i = 0; i < opp.count; i++) {
      const spread2 = Math.min(14, opp.count * 1.5);
      const tt = opp.count <= 1 ? 0 : (i / (opp.count - 1)) - 0.5;
      want.set(`opp-${oi}-${i}`, {
        pos: [p.x + tt * spread2 * Math.cos(p.rotY), 0.2, p.z + tt * spread2 * Math.sin(p.rotY)],
        rotY: p.rotY, tilt: 0.24, standing: true, faceUp: false, group: "opp",
      });
    }
  });
  for (let i = 0; i < (view.boneyardCount || 0); i++) {
    want.set(`bone-${i}`, { pos: [16.2 + (i % 3) * 0.25, 0.2 + Math.floor(i / 3) * (TILE.h + 0.06), 10.2 + (i % 3) * 0.25], rotY: PI / 2, faceUp: false, group: "bone" });
  }
  for (const [key, w] of want) {
    let e = tiles.get(key);
    if (!e || e.removing) {
      if (e) removeTile(key);
      e = makeTile(key, w);
      tiles.set(key, e);
      e.mesh.position.set(w.pos[0], instant ? w.pos[1] : w.pos[1] + 6, w.pos[2]);
      const r = targetRotation(w);
      e.mesh.rotation.set(r.x, r.y, 0, "YXZ");
    }
    w.lift = key === selectedKey ? 0.9 : 0;
    e.target = w;
    if (w.faceUp && w.face) setTileFace(e, w.face[0], w.face[1]);
    if (instant || reducedMotion) snapTo(e, w);
  }
  for (const [key, e] of tiles) {
    if (want.has(key)) continue;
    if (instant || reducedMotion) removeTile(key);
    else if (!e.removing) { e.removing = true; e.target = { pos: [e.mesh.position.x, 8, e.mesh.position.z], faceUp: e.target.faceUp, rotY: e.target.rotY, standing: e.target.standing, tilt: e.target.tilt, group: "out", remove: true }; }
  }
  syncMarkers(view);
  syncSelection();
}

const endPos: Record<"left" | "right", [number, number, number] | null> = { left: null, right: null };
function syncMarkers(view: View): void {
  if (!endMarkers || !endLabels || !theme) return;
  const show = view.myTurn && view.selectedPlayable;
  if (view.chain.length > 0) {
    const s0 = chainSlot(0), s1 = chainSlot(view.chain.length - 1);
    endPos.left = [s0.x - 2.6, 0.25, s0.z];
    endPos.right = [s1.x + 2.6, 0.25, s1.z];
  } else {
    endPos.left = [0, 0.25, -14];
    endPos.right = [0, 0.25, -14];
  }
  for (const end of ["left", "right"] as const) {
    const marker = endMarkers[end];
    const legal = show && view.legalEnds.includes(end);
    marker.visible = !!(legal && endPos[end]);
    if (marker.visible) {
      const p = endPos[end]!;
      marker.position.set(p[0], p[1], p[2]);
      (marker.material as MeshBasicMaterial).color.set(theme.accent).multiplyScalar(glow);
    }
    const val = end === "left" ? view.leftEnd : view.rightEnd;
    const lbl = endLabels[end];
    lbl.visible = marker.visible && val !== null;
    if (lbl.visible) {
      const p = endPos[end]!;
      lbl.position.set(p[0], 2.2, p[2]);
      (lbl.material as SpriteMaterial).map = labelTexture(String(val));
    }
  }
  syncGhost(view);
}
function syncGhost(view: View): void {
  if (!ghost) return;
  const show = view.myTurn && view.selectedPlayable && hovered?.kind === "end" && view.legalEnds.includes(hovered.end) && !!endPos[hovered.end];
  ghost.visible = !!show;
  if (show && hovered?.kind === "end") {
    const p = endPos[hovered.end]!;
    ghost.position.set(p[0], 0.25, p[2]);
  }
}
/** The selected hand tile (lifted, with a ring under it and a warm glow). */
export function setSelected(id: number | null): void {
  selectedKey = id === null ? null : String(id);
  syncSelection();
}
function syncSelection(): void {
  const e = selectedKey ? tiles.get(selectedKey) : null;
  if (selRing) {
    selRing.visible = !!(e && !e.removing);
    if (e && selRing.visible) selRing.position.set(e.mesh.position.x, 0.22, e.mesh.position.z);
  }
  for (const [, x] of tiles) {
    const isSel = x.key === selectedKey;
    if (!x.target.remove) x.target.lift = isSel ? 0.9 : 0;
    const m = x.faceMat as MeshStandardMaterial;
    if ("emissive" in m && theme) {
      m.emissive.set(isSel ? theme.accent : 0x000000);
      m.emissiveIntensity = isSel ? 0.25 : 0;
    }
  }
}

/** Skip: every tile at its exact target, the camera settled. */
export function settle(): void {
  camT = 1;
  applyCamera(1);
  for (const [key, e] of [...tiles]) {
    if (e.target.remove) removeTile(key);
    else snapTo(e, e.target);
  }
  shakeAmp = 0;
}
/** Clears the table (no match). */
export function clear(): void {
  lastView = null;
  for (const key of [...tiles.keys()]) removeTile(key);
  selectedKey = null;
  if (endMarkers) { endMarkers.left.visible = endMarkers.right.visible = false; }
  if (endLabels) { endLabels.left.visible = endLabels.right.visible = false; }
  if (ghost) ghost.visible = false;
  if (selRing) selRing.visible = false;
}

// ---------------------------------------------------------------- picking
export type Pick = { kind: "tile"; tileId: number } | { kind: "end"; end: "left" | "right" } | { kind: "table" };
const ray = new Raycaster();
/** What lies under a window pixel: a hand tile, a shown end marker, or the table. */
export function pick(x: number, y: number): Pick {
  if (!renderer.camera) return { kind: "table" };
  ray.setFromCamera(pointerToNdc(x, y), camera);
  const objs: Object3D[] = [];
  const owner = new Map<Object3D, Pick>();
  for (const [key, e] of tiles) {
    if (e.target.group === "hand" && !e.removing) { objs.push(e.mesh); owner.set(e.mesh, { kind: "tile", tileId: Number(key) }); }
  }
  if (endMarkers) for (const end of ["left", "right"] as const) {
    if (endMarkers[end].visible) { objs.push(endMarkers[end]); owner.set(endMarkers[end], { kind: "end", end }); }
  }
  const hits = ray.intersectObjects(objs, false);
  return (hits.length && owner.get(hits[0]!.object)) || { kind: "table" };
}
/** The pointer's hover (the ghost preview over a legal end). */
export function hover(p: Pick | null): void {
  const next = p && p.kind !== "table" ? p : null;
  if (JSON.stringify(next) === JSON.stringify(hovered)) return;
  hovered = next;
  if (lastView) syncGhost(lastView);
}

// ---------------------------------------------------------------- camera
let camT = 1;
let topDown = false;
let distScale = 1;
let shakeAmp = 0;
const basePos = new Vector3();
const look0 = new Vector3(FRAMING.camLook[0], FRAMING.camLook[1], FRAMING.camLook[2]);
function applyCamera(tt: number): void {
  const ease = tt >= 1 ? 1 : 1 - Math.pow(1 - tt, 3);
  const p = FRAMING.introFrom, q = topDown ? TOP_DOWN : FRAMING.camPos;
  const l = (a: number, b: number): number => a + (b - a) * ease;
  camera.position.set(l(p[0]!, q[0]!) * distScale, l(p[1]!, q[1]!) * distScale, l(p[2]!, q[2]!) * distScale);
  camera.lookAt(look0);
  basePos.copy(camera.position);
}
/** Pulls the camera back until the hand arc and the chain area fit the play area (the chain strip covers its bottom). */
function fitCamera(): void {
  const q = topDown ? TOP_DOWN : FRAMING.camPos;
  const pts: Vector3[] = [];
  for (const x of [-13.5, 13.5]) pts.push(new Vector3(x, 2.4, 16.8));
  for (const x of [-14, 14]) pts.push(new Vector3(x, 0, -14));
  pts.push(new Vector3(0, 0, -18));
  const v = new Vector3();
  let ds = 1;
  const margin = 0.9;
  // The projection without the view offset: the play area's own frustum.
  const probe = new PerspectiveCamera(camera.fov, view.w / view.h, 0.5, 300);
  for (let i = 0; i < 14; i++) {
    probe.position.set(q[0]! * ds, q[1]! * ds, q[2]! * ds);
    probe.lookAt(look0);
    probe.updateMatrixWorld();
    probe.updateProjectionMatrix();
    let worst = 0;
    for (const p of pts) {
      v.copy(p).project(probe);
      const yLimit = v.y < 0 ? 0.74 : margin;
      worst = Math.max(worst, Math.abs(v.x), Math.abs(v.y) * (margin / yLimit));
    }
    if (worst <= margin) break;
    ds *= Math.min(1.5, worst / margin + 0.01);
  }
  distScale = ds;
}
export function resetCamera(): void { topDown = false; camT = 1; fitCamera(); applyCamera(1); }
export function toggleTopDown(): boolean { topDown = !topDown; camT = 1; fitCamera(); applyCamera(1); return topDown; }
export function isTopDown(): boolean { return topDown; }
/** A new match: the authored swoop in (none with reduced motion). */
export function intro(): void { topDown = false; camT = reducedMotion ? 1 : 0; fitCamera(); applyCamera(camT); }
export function shake(amount: number): void { if (!reducedMotion) shakeAmp = Math.min(0.5, amount); }

let view = { x: 0, y: 0, w: 1, h: 1, W: 1, H: 1 };
/** The play area (window pixels) the table is framed into, within the W × H window. */
export function setPlayfield(x: number, y: number, w: number, h: number, W: number, H: number): void {
  const next = { x, y, w: Math.max(1, w), h: Math.max(1, h), W: Math.max(1, W), H: Math.max(1, H) };
  if (Object.entries(next).every(([k, v]) => Math.abs(v - (view as Record<string, number>)[k]!) < 0.5)) return;
  view = next;
  camera.fov = view.w / view.h < 0.9 ? 54 : FRAMING.fov;
  camera.aspect = view.w / view.h;
  camera.setViewOffset(view.w, view.h, -view.x, -view.y, view.W, view.H);
  camera.updateProjectionMatrix();
  fitCamera();
  applyCamera(camT);
}
/** Whether the 3D table draws (only in a match: the menus sit on their own backgrounds). */
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }

// ---------------------------------------------------------------- the look and theme
export function setTheme(next: Theme): void {
  if (theme && theme.id === next.id) return;
  theme = next;
  faceCache.clear();
  build();
}
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  const faceChanged = !look || look.budget.faceTexture !== next.budget.faceTexture;
  look = next;
  if (faceChanged) faceCache.clear();
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 1.1, distanceExponent: 1.4, thickness: 1.2, scale: 1.0,
    samples: next.ao === "high" ? 16 : 8,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // High threshold: only the window glow and the glowing markers bloom.
  renderer.bloom = next.bloom ? { strength: 0.45, radius: 0.4, threshold: 1.0, resolution: next.budget.bloomRes } : null;
  // The browser build's grade pass, a ShaderPass before OutputPass (linear light):
  // S-curve 0.18, saturation 1.07, cool shadows / warm highlights, over-range light
  // kept (mix(c, s + max(c - 1, 0), amount)), the 0.2 vignette.
  renderer.grade = next.grade ? {
    space: "linear", overRange: "keep", contrast: 0.18, saturation: 1.07,
    shadows: [0.97, 0.99, 1.04], highlights: [1.04, 1.0, 0.95], split: [0.2, 0.8],
    vignette: { amount: 0.2, inner: 0.4, outer: 0.85 },
  } : null;
  renderer.antialias = next.antialias;
  build();
}
export function setReducedMotion(on: boolean): void {
  reducedMotion = on;
  if (on) { camT = 1; applyCamera(1); shakeAmp = 0; }
}

// ---------------------------------------------------------------- the frame
const K = 90, C = 2 * Math.sqrt(K);
/** Each frame: the intro swoop, the shake, the tiles' springs, the steam, the window light, the marker pulse. */
export function update(dtIn: number): void {
  const dt = Math.min(0.05, Math.max(0, dtIn));
  time += dt;
  if (camT < 1) { camT = Math.min(1, camT + dt / 1.4); applyCamera(camT); }
  if (shakeAmp > 0.001 && !reducedMotion) {
    camera.position.x = basePos.x + Math.sin(time * 90) * shakeAmp;
    camera.position.y = basePos.y + Math.cos(time * 110) * shakeAmp * 0.6;
    shakeAmp *= Math.pow(0.02, dt);
  } else if (camT >= 1) camera.position.copy(basePos);

  for (const [, e] of [...tiles]) {
    const w = e.target;
    const m = e.mesh;
    const tx = w.pos[0], ty = w.pos[1] + (w.lift || 0), tz = w.pos[2];
    if (reducedMotion) m.position.set(tx, ty, tz);
    else {
      e.vel.x += (K * (tx - m.position.x) - C * e.vel.x) * dt;
      e.vel.y += (K * (ty - m.position.y) - C * e.vel.y) * dt;
      e.vel.z += (K * (tz - m.position.z) - C * e.vel.z) * dt;
      m.position.x += e.vel.x * dt;
      m.position.y += e.vel.y * dt;
      m.position.z += e.vel.z * dt;
    }
    const r = targetRotation(w);
    const rs = reducedMotion ? 1 : Math.min(1, dt * 10);
    m.rotation.x += (r.x - m.rotation.x) * rs;
    m.rotation.y += (r.y - m.rotation.y) * rs;
    if (w.remove && m.position.y > 6.5) removeTile(e.key);
  }
  if (selRing?.visible && selectedKey) { const e = tiles.get(selectedKey); if (e) selRing.position.set(e.mesh.position.x, 0.22, e.mesh.position.z); }

  if (steam && !reducedMotion) updateSteam(time, dt);
  if (look?.ambience && !reducedMotion && winGlow) {
    const n = Math.sin(time * 0.53) * 0.6 + Math.sin(time * 1.31 + 1.7) * 0.3 + Math.sin(time * 2.9 + 0.4) * 0.1;
    keyLight.intensity = keyBase * (1 + n * 0.035);
    pendant.intensity = pendantBase * (1 + Math.sin(time * 0.8 + 2.1) * 0.06);
    (winGlow.material as MeshBasicMaterial).opacity = winOpacity * (1 + n * 0.08);
  }
  if (endMarkers) {
    const pulse = reducedMotion ? 1 : 1 + Math.sin(time * 5) * 0.08;
    for (const end of ["left", "right"] as const) if (endMarkers[end].visible) endMarkers[end].scale.setScalar(pulse);
  }
}
void Vector2;
