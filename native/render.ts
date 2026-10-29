// The rooftop parking diorama on starhermit:scene, as the browser build's
// main.js renderer drew it with three.js r185: the authored camera that backs
// off until the whole lot fits, the hemisphere fill and the key light with
// its shadows, the rooftop slab, the asphalt lot with its grid lines, the
// parapet walls with the gap at the exit, the glowing exit gate, the seeded
// rooftop props, the vehicles (plain blocks on Low; rounded clear-coated
// bodies with glass cabins, axles and light bars on detailed looks, the red
// car with its white stripe), the selection ring and the legal-target
// markers, the invalid-move jiggle, the selected vehicle's lift and idle
// bob, the confetti at the exit, and on detailed looks the asphalt and
// concrete grain, parapet caps, AC units and vents, lamp posts, the
// blinking antenna beacon, gate bollards with pulsing chevrons, drifting dust
// and the instanced city skyline whose windows light up at dusk and night.
// Slides animate on a 0.16 s ease-out; reduced motion snaps them and stops
// the bob, pulses, blink and drift.
//
// From three.js r185 (engine.minor 28): light intensities, shadow box and bias as main.js set them;
// RoomEnvironment(renderer) lowered as r183+ + PMREM give the reflections at the
// old environmentIntensity 0.45; the post chain (GTAO, UnrealBloom 0.4 /
// 0.35 / 0.92 before the output pass's ACES, the GradeShader, FXAA / SMAA /
// MSAA) is renderer.ao / bloom / grade / antialias. The skyline's
// six-material instanced box is two instanced meshes (facades and roofs:
// InstancedMesh takes one material). The lot is framed in the playfield
// rectangle the status bar, rails and tray leave (setViewOffset), as the
// DOM canvas sat between them. Rendering never touches the rules state.
import {
  ACESFilmicToneMapping, BoxGeometry, BufferGeometry, CanvasTexture, CircleGeometry, Color, CylinderGeometry, DirectionalLight,
  DoubleSide, ExtrudeGeometry, Fog, Group, HemisphereLight, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial,
  MeshPhysicalMaterial, MeshStandardMaterial, PerspectiveCamera, Plane, PMREMGenerator, Points, PointsMaterial, Quaternion, Raycaster,
  OrthographicCamera, RepeatWrapping, RingGeometry, RoomEnvironment, SRGBColorSpace, Shape, ShapeGeometry, SphereGeometry, Vector3, pointerToNdc, renderer, scene,
  BufferAttribute, type Material, type Object3D, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import { Content, Rules, type Entry, type Move, type State, type Theme, type Vehicle } from "./classic.ts";
import type { Look } from "./quality.ts";

export const CELL = 1.6;
const GRID = Rules.GRID;
const camera = new PerspectiveCamera(46, 1, 0.1, 200);
const CAM_HOME = { pos: new Vector3(0, 11.5, 10.5), look: new Vector3(0, 0, 0.4) };
const PI = Math.PI;

const hemi = new HemisphereLight(0xffffff, 0x333344, 0.85);
const key = new DirectionalLight(0xffffff, 1.6);
key.position.set(8, 14, 6);
key.castShadow = true;
// shadow frustum fitted to the rooftop slab + props (half extent ≈ 7.6), as main.js set it
{
  const sc = 8, cam = key.shadow.camera as OrthographicCamera;
  Object.assign(cam, { left: -sc, right: sc, top: sc, bottom: -sc, near: 4, far: 34 });
  cam.updateProjectionMatrix();
}
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
key.shadow.radius = 3;
scene.add(hemi, key, key.target);

// layers: 0 environment, 1 gameplay (vehicles), 2 markers / ghosts
const LAYER_GAME = 1, LAYER_MARK = 2;

let look: Look | null = null;
let theme: Theme = Content.THEMES[0]!;
let entry: Entry | null = null;
let state: State | null = null;
let selected = -1;
let over = false;
let reducedMotion = false;

let boardGroup: Group | null = null;
interface View { mesh: Group; anim: { from: Vector3; to: Vector3; t: number } | null; shake: number; shakeBaseX: number }
let views: View[] = [];
let markerMeshes: Mesh[] = [];
let selectRing: Mesh | null = null;
let exitGate: Mesh<MeshLambertMaterial | MeshStandardMaterial> | null = null;
let ambient: { chevrons: Mesh<MeshLambertMaterial | MeshStandardMaterial>[]; beacon: Mesh<MeshLambertMaterial | MeshStandardMaterial>; dust: Points | null } | null = null;
let vfx: { m: Mesh; vel: Vector3; life: number }[] = [];
let avRng = Rules.rng(1234); // audiovisual variant stream (never rules)

function cellToWorld(x: number, y: number): { x: number; z: number } {
  return { x: (x - (GRID - 1) / 2) * CELL, z: (y - (GRID - 1) / 2) * CELL };
}
function disposeTree(root: Object3D): void {
  const geos = new Set<BufferGeometry>(), mats = new Set<Material>();
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry) geos.add(m.geometry);
    if (m.material) for (const x of Array.isArray(m.material) ? m.material : [m.material]) mats.add(x);
  });
  for (const g of geos) g.dispose();
  for (const m of mats) m.dispose();
}

// ---------------------------------------------------------------- shared procedural textures (built once per size)
const texCache = new Map<string, CanvasTexture>();
type Ctx = OffscreenCanvasRenderingContext2D;
function canvasTexture(name: string, size: [number, number], draw: (c: Ctx, w: number, h: number, rnd: () => number) => void, repeat: number, px?: number): CanvasTexture {
  const k = name + (px ? `@${px}` : "");
  const hit = texCache.get(k);
  if (hit) return hit;
  const w = px || size[0], h = px ? Math.round((px * size[1]) / size[0]) : size[1];
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext("2d");
  ctx.scale(w / size[0], h / size[1]);
  draw(ctx, size[0], size[1], Rules.rng(0x5eed + name.length * 97));
  const t = new CanvasTexture(cv);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  if (repeat) t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  texCache.set(k, t);
  return t;
}
/** Near-white grain so the theme colour still reads as the surface colour. */
function speckle(ctx: Ctx, w: number, h: number, rnd: () => number, base: string, dots: number, blotches: number): void {
  ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < blotches; i++) {
    const x = rnd() * w, y = rnd() * h, r = 12 + rnd() * 40;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(0,0,0,${0.04 + rnd() * 0.06})`); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < dots; i++) {
    const v = 150 + Math.floor(rnd() * 105);
    ctx.fillStyle = `rgba(${v},${v},${v},0.55)`;
    ctx.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 1.5, 1 + rnd() * 1.5);
  }
}
const asphaltTex = (): Texture => canvasTexture("asphalt", [256, 256], (c, w, h, r) => speckle(c, w, h, r, "#f0f0f0", 5200, 26), 3, look!.budget.texture);
const concreteTex = (): Texture => canvasTexture("concrete", [256, 256], (c, w, h, r) => {
  speckle(c, w, h, r, "#f4f4f4", 1800, 40);
  c.strokeStyle = "rgba(0,0,0,0.12)"; c.lineWidth = 2;
  for (let p = 0; p <= w; p += 64) { c.beginPath(); c.moveTo(p, 0); c.lineTo(p, h); c.moveTo(0, p); c.lineTo(w, p); c.stroke(); }
}, 2, look!.budget.texture);
const windowTex = (): Texture => canvasTexture("windows", [64, 128], (c, w, h, r) => {
  c.fillStyle = "#000"; c.fillRect(0, 0, w, h);
  for (let y = 6; y < h - 6; y += 10) for (let x = 5; x < w - 5; x += 9) {
    if (r() < 0.42) { const v = 170 + Math.floor(r() * 85); c.fillStyle = `rgb(${v},${Math.floor(v * 0.86)},${Math.floor(v * 0.6)})`; c.fillRect(x, y, 5, 6); }
  }
}, 0);

// ---------------------------------------------------------------- geometry and materials
/** Rounded slab: a rounded-rectangle footprint (sx × sz) extruded to height h with bevelled edges; base at y = 0. */
function roundedSlab(sx: number, sz: number, h: number, r: number, bevel: number): BufferGeometry {
  const hx = sx / 2 - bevel, hz = sz / 2 - bevel;
  r = Math.max(0.01, Math.min(r, hx - 0.01, hz - 0.01));
  const s = new Shape();
  s.moveTo(-hx + r, -hz); s.lineTo(hx - r, -hz); s.quadraticCurveTo(hx, -hz, hx, -hz + r);
  s.lineTo(hx, hz - r); s.quadraticCurveTo(hx, hz, hx - r, hz);
  s.lineTo(-hx + r, hz); s.quadraticCurveTo(-hx, hz, -hx, hz - r);
  s.lineTo(-hx, -hz + r); s.quadraticCurveTo(-hx, -hz, -hx + r, -hz);
  const b = look!.budget;
  const g = new ExtrudeGeometry(s, { depth: Math.max(0.01, h - 2 * bevel), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: b.bevel, curveSegments: b.curve });
  g.rotateX(-PI / 2);
  g.translate(0, bevel, 0);
  return g;
}
type Lit = MeshLambertMaterial | MeshStandardMaterial;
interface LitParams {
  color?: number | Color; emissive?: number | Color; emissiveIntensity?: number; emissiveMap?: Texture | null; map?: Texture | null;
  roughness?: number; metalness?: number; clearcoat?: number; clearcoatRoughness?: number; transparent?: boolean; opacity?: number;
}
/** Lambert on Low (emissive kept), Standard on Balanced, Physical (clear-coated paint and glass) only on High/Ultra. */
function lit(p: LitParams, physical = false): Lit {
  const tier = look!.budget.material;
  const base = { color: p.color ?? 0xffffff, emissive: p.emissive ?? 0x000000, emissiveIntensity: p.emissiveIntensity ?? 1, map: p.map ?? null, emissiveMap: p.emissiveMap ?? null };
  if (tier === "lambert") return new MeshLambertMaterial(base);
  const std = { ...base, roughness: p.roughness ?? 1, metalness: p.metalness ?? 0 };
  if (physical && tier === "physical") return new MeshPhysicalMaterial({ ...std, clearcoat: p.clearcoat ?? 0, clearcoatRoughness: p.clearcoatRoughness ?? 0 });
  return new MeshStandardMaterial(std);
}
let sharedMats: Map<string, Lit> | null = null;
let sharedGeos: Map<string, BufferGeometry> | null = null;
function shared(name: string, make: () => Lit): Lit {
  sharedMats ??= new Map();
  let m = sharedMats.get(name);
  if (!m) { m = make(); sharedMats.set(name, m); }
  return m;
}
function sharedGeo(name: string, make: () => BufferGeometry): BufferGeometry {
  sharedGeos ??= new Map();
  let g = sharedGeos.get(name);
  if (!g) { g = make(); sharedGeos.set(name, g); }
  return g;
}
function setLayer(o: Object3D, layer: number): void { o.traverse((c) => c.layers.set(layer)); }

function makeVehicleMesh(v: Vehicle, isTarget: boolean, colorHex: number): Group {
  if (look!.detailed) return makeDetailedVehicle(v, isTarget, colorHex);
  const grp = new Group();
  const L = v.len * CELL * 0.92, W = CELL * 0.72, H = 0.5;
  const mat = isTarget
    ? lit({ color: colorHex, emissive: colorHex, emissiveIntensity: 0.35, roughness: 0.4 })
    : lit({ color: colorHex, roughness: 0.45, metalness: 0.25 });
  const body = new Mesh(new BoxGeometry(v.ori === "h" ? L : W, H, v.ori === "h" ? W : L), mat);
  body.position.y = H / 2 + 0.12;
  body.castShadow = true;
  grp.add(body);
  const cabMat = shared("cab", () => lit({ color: 0x223044, roughness: 0.2, metalness: 0.4 }));
  const cab = new Mesh(new BoxGeometry(v.ori === "h" ? L * 0.42 : W * 0.8, 0.32, v.ori === "h" ? W * 0.8 : L * 0.42), cabMat);
  cab.position.y = H + 0.28;
  grp.add(cab);
  const wheelGeo = sharedGeo("wheel", () => new CylinderGeometry(0.16, 0.16, 0.12, 10));
  const wheelMat = shared("wheel", () => lit({ color: 0x15181d, roughness: 0.9 }));
  const offs = v.ori === "h" ? [[-L / 2 + 0.35, -W / 2], [L / 2 - 0.35, -W / 2], [-L / 2 + 0.35, W / 2], [L / 2 - 0.35, W / 2]]
    : [[-W / 2, -L / 2 + 0.35], [W / 2, -L / 2 + 0.35], [-W / 2, L / 2 - 0.35], [W / 2, L / 2 - 0.35]];
  for (const [ox, oz] of offs) {
    const w = new Mesh(wheelGeo, wheelMat);
    w.rotation.z = PI / 2;
    w.rotation.y = v.ori === "v" ? PI / 2 : 0;
    w.position.set(ox!, 0.16, oz!);
    grp.add(w);
  }
  setLayer(grp, LAYER_GAME);
  return grp;
}

/** Detailed vehicle: rounded clear-coated body, glass cabin, axles, light bars; built along +x (front), turned for upright ones. */
function makeDetailedVehicle(v: Vehicle, isTarget: boolean, colorHex: number): Group {
  const grp = new Group();
  const car = new Group();
  if (v.ori === "v") car.rotation.y = -PI / 2;
  grp.add(car);
  const L = v.len * CELL * 0.92, W = CELL * 0.72, CL = 0.13;
  const paint = lit({
    color: colorHex, roughness: 0.4, metalness: 0.15, clearcoat: 0.7, clearcoatRoughness: 0.1,
    emissive: isTarget ? colorHex : 0x000000, emissiveIntensity: isTarget ? 0.22 : 0,
  }, true);
  const glass = shared("glass", () => lit({ color: 0x16202c, roughness: 0.06, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.03 }, true));
  const rubber = shared("rubber", () => lit({ color: 0x14171b, roughness: 0.85 }));
  const head = shared("head", () => lit({ color: 0xfff4dc, emissive: 0xfff1d0, emissiveIntensity: 1.5 }));
  const tail = shared("tail", () => lit({ color: 0xff3b30, emissive: 0xff2a1a, emissiveIntensity: 1.8 }));
  const add = (geo: BufferGeometry, mat: Material, x: number, y: number, z: number, cast = false): Mesh => {
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = cast;
    car.add(m);
    return m;
  };
  let bodyTop: number;
  if (v.len >= 3) {
    // box van: tall cargo body at the back, lower cab with windscreen at the front
    add(roundedSlab(L * 0.7, W, 0.8, 0.16, 0.06), paint, -L * 0.15, CL, 0, true);
    add(roundedSlab(L * 0.31, W * 0.96, 0.46, 0.24, 0.08), paint, L * 0.345, CL, 0, true);
    add(roundedSlab(L * 0.17, W * 0.86, 0.24, 0.1, 0.05), glass, L * 0.3, CL + 0.42, 0, true);
    bodyTop = CL + 0.8;
  } else {
    add(roundedSlab(L, W, 0.42, 0.3, 0.08), paint, 0, CL, 0, true);
    add(roundedSlab(L * 0.52, W * 0.84, 0.3, 0.22, 0.06), glass, -L * 0.05, CL + 0.38, 0, true);
    add(roundedSlab(L * 0.42, W * 0.78, 0.05, 0.18, 0.02), paint, -L * 0.06, CL + 0.67, 0, false);
    bodyTop = CL + 0.42;
  }
  // axles: one cylinder per axle, tyres peek out at both sides
  const axle = sharedGeo("axle", () => new CylinderGeometry(0.17, 0.17, W * 0.98, 16).rotateX(PI / 2));
  add(axle, rubber, L / 2 - 0.42, 0.17, 0, true);
  add(axle, rubber, -L / 2 + 0.42, 0.17, 0, true);
  // light bars: warm head lights at the front, red tail lights at the back (bloom sources)
  const bar = sharedGeo("bar", () => new BoxGeometry(0.05, 0.07, W * 0.72));
  add(bar, head, L / 2 - 0.01, CL + 0.26, 0);
  add(bar, tail, -L / 2 + 0.01, CL + 0.3, 0);
  if (isTarget) {
    // white racing stripe: the target reads by shape, not colour alone
    const stripeMat = shared("stripe", () => lit({ color: 0xffffff, roughness: 0.4 }));
    add(new BoxGeometry(L * 0.9, 0.012, 0.16), stripeMat, 0, bodyTop + 0.004, 0);
    if (v.len < 3) add(new BoxGeometry(L * 0.4, 0.012, 0.16), stripeMat, -L * 0.06, CL + 0.724, 0);
  }
  setLayer(grp, LAYER_GAME);
  return grp;
}

/** BoxGeometry's index split by its face groups (+x, -x, +y, -y, +z, -z): the faces listed. */
function boxFaces(faces: number[]): BufferGeometry {
  const box = new BoxGeometry(1, 1, 1);
  const idx = box.index!;
  const list: number[] = [];
  for (const f of faces) for (let i = f * 6; i < f * 6 + 6; i++) list.push(idx.getX(i));
  const g = new BufferGeometry();
  for (const name of ["position", "normal", "uv"] as const) {
    const a = box.getAttribute(name);
    if (a) g.setAttribute(name, new BufferAttribute(new Float32Array(a.array as ArrayLike<number>), a.itemSize));
  }
  g.setIndex(list);
  box.dispose();
  return g;
}
/** Distant city blocks under the rooftop (instanced facades and roofs), fogged into the sky. */
function buildSkyline(group: Group): void {
  const rnd = Rules.rng(0xc17e);
  const n = look!.budget.skyline;
  const facade = lit({
    color: new Color(theme.fog).lerp(new Color(0x2a3444), 0.55), roughness: 0.9,
    emissive: 0xffe2b0, emissiveMap: windowTex(),
    emissiveIntensity: theme.id === "night" ? 1.3 : theme.id === "dusk" || theme.id === "contrast" ? 0.6 : 0.12,
  });
  const roof = lit({ color: new Color(theme.fog).multiplyScalar(0.42), roughness: 0.95 });
  const sides = new InstancedMesh(boxFaces([0, 1, 4, 5]), facade, n);
  const tops = new InstancedMesh(boxFaces([2, 3]), roof, n);
  const m = new Matrix4(), p = new Vector3(), s = new Vector3(), q = new Quaternion(), up = new Vector3(0, 1, 0);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * PI * 2 + rnd() * 0.12;
    const r = 16 + rnd() * 20;
    const top = -15 + rnd() * 11, bottom = -48;
    s.set(2.4 + rnd() * 3.5, top - bottom, 2.4 + rnd() * 3.5);
    p.set(Math.cos(a) * r, (top + bottom) / 2, Math.sin(a) * r);
    q.setFromAxisAngle(up, rnd() * 0.5);
    m.compose(p, q, s);
    sides.setMatrixAt(i, m);
    tops.setMatrixAt(i, m);
  }
  group.add(sides, tops);
}

function buildDetailedProps(group: Group, half: number, size: number, exZ: number, seed: number): NonNullable<typeof ambient> {
  const deco = Rules.rng(seed ^ 0xdec0);
  const metal = lit({ color: 0x7b8594, roughness: 0.45, metalness: 0.6 });
  const dark = lit({ color: 0x2a3038, roughness: 0.6, metalness: 0.4 });
  const add = <M extends Material>(geo: BufferGeometry, mat: M, x: number, y: number, z: number): Mesh<M> => {
    const m = new Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; group.add(m); return m;
  };
  // seeded rooftop props: AC units with fan grilles and round vents
  for (let i = 0; i < 7; i++) {
    const pw = 0.5 + deco() * 0.6, ph = 0.3 + deco() * 0.7, pd = 0.5 + deco() * 0.6;
    const side = Math.floor(deco() * 4);
    const off = half + 1.2 + deco() * 0.8;
    const along = (deco() - 0.5) * (size + 2);
    const x = side <= 1 ? along : side === 2 ? -off : off;
    const z = side === 0 ? -off : side === 1 ? off : along;
    if (deco() < 0.6) {
      add(roundedSlab(pw, pd, ph, 0.06, 0.03), metal, x, 0, z);
      add(new CylinderGeometry(Math.min(pw, pd) * 0.34, Math.min(pw, pd) * 0.34, 0.03, 18), dark, x, ph + 0.01, z);
    } else {
      add(new CylinderGeometry(0.16, 0.2, ph + 0.3, 14), metal, x, (ph + 0.3) / 2, z);
      add(new CylinderGeometry(0.3, 0.3, 0.06, 14), metal, x, ph + 0.33, z);
    }
  }
  // lamp posts at two corners (warm heads bloom at dusk/night)
  const lampMat = lit({ color: 0xfff3d6, emissive: 0xffe0a8, emissiveIntensity: 2.6 });
  for (const [lx, lz] of [[-half - 1.5, -half - 1.5], [half + 1.5, half + 1.5]] as const) {
    add(new CylinderGeometry(0.05, 0.07, 2.4, 10), dark, lx, 1.2, lz);
    add(new BoxGeometry(0.5, 0.08, 0.22), lampMat, lx + (lx < 0 ? 0.2 : -0.2), 2.42, lz);
  }
  // antenna mast with a blinking beacon
  add(new CylinderGeometry(0.03, 0.05, 3.1, 8), metal, half + 1.6, 1.55, -half - 1.6);
  const beaconMat = lit({ color: 0xff4040, emissive: 0xff2020, emissiveIntensity: 3 });
  const beacon = add(new SphereGeometry(0.08, 12, 8), beaconMat, half + 1.6, 3.15, -half - 1.6);
  beacon.castShadow = false;
  // exit gate: bollards and animated chevrons pointing out of the lot
  const bollard = lit({ color: 0xffc107, roughness: 0.5 });
  add(new CylinderGeometry(0.09, 0.09, 0.55, 12), bollard, half + 0.55, 0.28, exZ - CELL * 0.52);
  add(new CylinderGeometry(0.09, 0.09, 0.55, 12), bollard, half + 0.55, 0.28, exZ + CELL * 0.52);
  const chev = new Shape();
  chev.moveTo(-0.12, -0.34); chev.lineTo(0.02, -0.34); chev.lineTo(0.2, 0); chev.lineTo(0.02, 0.34); chev.lineTo(-0.12, 0.34); chev.lineTo(0.06, 0);
  const chevGeo = new ShapeGeometry(chev);
  chevGeo.rotateX(-PI / 2);
  const chevrons: Mesh<Lit>[] = [];
  for (let i = 0; i < 3; i++) {
    const m = new Mesh(chevGeo, lit({ color: 0x9dffd0, emissive: 0x3dffa0, emissiveIntensity: 1.2 }));
    m.position.set(half + 0.45 + i * 0.36, 0.125, exZ);
    group.add(m);
    chevrons.push(m);
  }
  // drifting dust motes (cosmetic, environment layer, never picked)
  let dust: Points | null = null;
  if (look!.particles === "high") {
    const n = look!.budget.dust, pos = new Float32Array(n * 3), prnd = Rules.rng(0xd057);
    for (let i = 0; i < n; i++) { pos[i * 3] = (prnd() - 0.5) * 15; pos[i * 3 + 1] = 0.3 + prnd() * 4; pos[i * 3 + 2] = (prnd() - 0.5) * 15; }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    dust = new Points(geo, new PointsMaterial({ color: 0xfff6e0, size: 0.06, transparent: true, opacity: 0.6, depthWrite: false }));
    group.add(dust);
  }
  return { chevrons, beacon, dust };
}

// ---------------------------------------------------------------- the board
function clearBoard(): void {
  if (boardGroup) { scene.remove(boardGroup); disposeTree(boardGroup); }
  for (const p of vfx) p.m.geometry.dispose();
  boardGroup = null;
  vfx = [];
  views = [];
  markerMeshes = [];
  selectRing = null;
  exitGate = null;
  ambient = null;
  sharedMats = null;
  sharedGeos = null;
}
/** main.js buildBoard: the lot for a round's content entry, in the player's theme or the stage's. */
function buildBoard(): void {
  clearBoard();
  if (!entry || !state || !look) return;
  const detailed = look.detailed;
  const grp = boardGroup = new Group();
  scene.add(grp);
  scene.background = new Color(theme.sky);
  scene.fog = new Fog(theme.fog, 24, 60);
  hemi.color.set(detailed ? theme.fog : 0xffffff);
  key.color.set(theme.key);
  frameKey = "";

  const size = GRID * CELL;
  // rooftop slab
  const slab = new Mesh(new BoxGeometry(size + 4.4, 0.8, size + 4.4), lit({ color: theme.slab, roughness: 0.95, map: detailed ? concreteTex() : null }));
  slab.position.y = -0.4;
  slab.receiveShadow = true;
  grp.add(slab);
  // parking surface
  const lot = new Mesh(new BoxGeometry(size + 0.5, 0.1, size + 0.5), lit({ color: theme.ground, roughness: 0.9, map: detailed ? asphaltTex() : null }));
  lot.position.y = 0.001;
  lot.receiveShadow = true;
  grp.add(lot);
  // grid lines (readable without effects); kept just under the bloom threshold
  const lineMat = new MeshBasicMaterial({ color: new Color(theme.line).multiplyScalar(0.9) });
  const hLine = new BoxGeometry(size, 0.02, 0.045), vLine = new BoxGeometry(0.045, 0.02, size);
  for (let i = 0; i <= GRID; i++) {
    const p = (i - GRID / 2) * CELL;
    const h = new Mesh(hLine, lineMat);
    h.position.set(0, 0.06, p);
    const vl = new Mesh(vLine, lineMat);
    vl.position.set(p, 0.06, 0);
    grp.add(h, vl);
  }
  // parapet walls with a gap at the exit
  const wallMat = lit({ color: theme.parapet, roughness: 0.85, map: detailed ? concreteTex() : null });
  const capMat = lit({ color: new Color(theme.parapet).offsetHSL(0, -0.05, 0.14), roughness: 0.7 });
  const exZ = cellToWorld(0, Rules.EXIT_ROW).z;
  const mkWall = (w: number, d: number, x: number, z: number): void => {
    const m = new Mesh(new BoxGeometry(w, 0.7, d), wallMat);
    m.position.set(x, 0.35, z);
    m.castShadow = true;
    m.receiveShadow = detailed;
    grp.add(m);
    if (detailed) {
      const cap = new Mesh(new BoxGeometry(w + 0.08, 0.07, d + 0.08), capMat);
      cap.position.set(x, 0.735, z);
      cap.castShadow = true;
      grp.add(cap);
    }
  };
  const half = size / 2;
  mkWall(size + 1, 0.35, 0, -half - 0.35);
  mkWall(size + 1, 0.35, 0, half + 0.35);
  mkWall(0.35, size + 1, -half - 0.35, 0);
  // right wall split around the exit row
  const exitHalf = CELL / 2;
  mkWall(0.35, half - exitHalf + 0.35, half + 0.35, -(exitHalf + (half - exitHalf) / 2));
  mkWall(0.35, half - exitHalf + 0.35, half + 0.35, exitHalf + (half - exitHalf) / 2);
  // exit gate: glowing ramp marker
  exitGate = new Mesh(new BoxGeometry(1.4, 0.06, CELL * 0.9), lit({ color: 0x2f9e6e, emissive: 0x2f9e6e, emissiveIntensity: 0.7 }));
  exitGate.position.set(half + 0.9, 0.08, exZ);
  grp.add(exitGate);
  if (detailed) {
    ambient = buildDetailedProps(grp, half, size, exZ, entry.seed);
    buildSkyline(grp);
  } else {
    // seeded rooftop props: vents, AC boxes, antenna (visual seed deterministic)
    const deco = Rules.rng(entry.seed ^ 0xdec0);
    const propMat = lit({ color: 0x6b7686, roughness: 0.8, metalness: 0.3 });
    for (let i = 0; i < 7; i++) {
      const pw = 0.4 + deco() * 0.7, ph = 0.3 + deco() * 1.1, pd = 0.4 + deco() * 0.7;
      const prop = new Mesh(new BoxGeometry(pw, ph, pd), propMat);
      const side = Math.floor(deco() * 4);
      const off = half + 1.2 + deco() * 0.8;
      const along = (deco() - 0.5) * (size + 2);
      prop.position.set(side <= 1 ? along : side === 2 ? -off : off, ph / 2, side === 0 ? -off : side === 1 ? off : along);
      prop.castShadow = true;
      grp.add(prop);
    }
  }
  // selection ring
  selectRing = new Mesh(new RingGeometry(0.62, 0.78, 32), new MeshBasicMaterial({ color: 0xffd54f, side: DoubleSide, transparent: true, opacity: 0.95 }));
  selectRing.rotation.x = -PI / 2;
  selectRing.position.y = 0.07;
  selectRing.visible = false;
  selectRing.layers.set(LAYER_MARK);
  grp.add(selectRing);
  // vehicle views
  state.vehicles.forEach((v, i) => {
    const color = v.target ? theme.target : theme.palette[(i + theme.palette.length - 1) % theme.palette.length]!;
    const mesh = makeVehicleMesh(v, v.target, color);
    mesh.userData.vehicleIndex = i;
    grp.add(mesh);
    views.push({ mesh, anim: null, shake: 0, shakeBaseX: 0 });
  });
  applyReflections();
  syncVehicles(false);
}

function vehicleCenter(v: Vehicle): { x: number; z: number } {
  const cx = v.ori === "h" ? v.x + (v.len - 1) / 2 : v.x;
  const cy = v.ori === "v" ? v.y + (v.len - 1) / 2 : v.y;
  return cellToWorld(cx, cy);
}
function syncVehicles(animate: boolean): void {
  if (!state) return;
  state.vehicles.forEach((v, i) => {
    const view = views[i];
    if (!view) return;
    const p = vehicleCenter(v);
    if (view.shake && !view.anim) view.mesh.position.x = view.shakeBaseX;
    view.shake = 0;
    if (animate && !reducedMotion) {
      view.anim = { from: view.mesh.position.clone().setY(0), to: new Vector3(p.x, 0, p.z), t: 0 };
    } else {
      view.mesh.position.set(p.x, view.mesh.position.y, p.z);
      view.anim = null;
    }
  });
  updateSelectionVisual();
}
function updateSelectionVisual(): void {
  if (!state || !selectRing) return;
  const view = views[selected];
  if (view && !over) {
    const v = state.vehicles[selected]!;
    const p = vehicleCenter(v);
    selectRing.visible = true;
    selectRing.position.set(p.x, 0.07, p.z);
    const s = Math.max(1, (v.len * CELL) / 2.4);
    selectRing.scale.set(v.ori === "h" ? s : 1, v.ori === "h" ? 1 : s, 1);
    showMarkers(selected);
  } else {
    selectRing.visible = false;
    clearMarkers();
  }
}
function clearMarkers(): void {
  for (const m of markerMeshes) { boardGroup?.remove(m); m.geometry.dispose(); (m.material as Material).dispose(); }
  markerMeshes = [];
}
/** The legal-target markers of a vehicle: where each legal slide would park it. */
export function markersFor(vIdx: number): { move: Move; x: number; y: number }[] {
  if (!state) return [];
  const v = state.vehicles[vIdx];
  if (!v) return [];
  return Rules.legalActions(state).filter((a) => a.v === vIdx).map((a) => {
    const nx = v.ori === "h" ? v.x + a.dir * a.dist : v.x;
    const ny = v.ori === "v" ? v.y + a.dir * a.dist : v.y;
    return { move: a, x: v.ori === "h" ? nx + (v.len - 1) / 2 : nx, y: v.ori === "v" ? ny + (v.len - 1) / 2 : ny };
  });
}
function showMarkers(vIdx: number): void {
  clearMarkers();
  if (!boardGroup) return;
  for (const mk of markersFor(vIdx)) {
    const p = cellToWorld(mk.x, mk.y);
    const m = new Mesh(new CircleGeometry(0.3, 20), new MeshBasicMaterial({ color: 0x4dd0e1, transparent: true, opacity: 0.75, side: DoubleSide }));
    m.rotation.x = -PI / 2;
    m.position.set(p.x, 0.075, p.z);
    m.userData.move = mk.move;
    m.layers.set(LAYER_MARK);
    boardGroup.add(m);
    markerMeshes.push(m);
  }
}

// ---------------------------------------------------------------- the look
let envTexture: Texture | null = null;
function envMap(): Texture | null {
  if (!envTexture) {
    try {
      const room = new RoomEnvironment(renderer);
      room.position.y = -3.5; // three.js r183+ lowers the room
      envTexture = new PMREMGenerator(renderer).fromScene(room, 0.04).texture;
    }
    catch (e) { console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return envTexture;
}
function applyReflections(): void {
  const env = look && look.reflections ? envMap() : null;
  scene.environment = env;
  scene.environmentIntensity = 0.45;
  hemi.intensity = env ? 0.5 : 0.85;
}
let lookKey = "";
export function applyLook(next: Look): void {
  const k = JSON.stringify(next);
  if (k === lookKey) return;
  const rebuildTex = !look || look.budget.texture !== next.budget.texture;
  lookKey = k;
  look = next;
  if (rebuildTex) { for (const t of texCache.values()) t.dispose(); texCache.clear(); }
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const b = next.budget;
  const hi = next.ao === "high";
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 0.45, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: hi ? 16 : 8, resolution: b.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: hi ? 6 : 4, rings: 2, samples: hi ? 16 : 8, radiusExponent: 2 },
  };
  // UnrealBloomPass(0.4, 0.35, 0.92) in the composer before its output pass (linear light): only emissive lights bloom.
  renderer.bloom = next.bloom ? { strength: 0.4, radius: 0.35, threshold: 0.92, resolution: b.bloomRes } : null;
  // post.js GradeShader (linear light before the output): a 0.18 S-curve, saturation 1.1, cool shadows / warm highlights, the 0.2 vignette.
  renderer.grade = next.grade ? {
    space: "linear", contrast: 0.18, saturation: 1.1, shadows: [0.97, 0.98, 1.04], highlights: [1.03, 1.0, 0.97], split: [0.2, 0.8],
    vignette: { amount: 0.2, inner: 0.38, outer: 0.85 },
  } : null;
  renderer.antialias = next.antialias;
  renderer.shadowMap.enabled = next.shadows > 0;
  key.castShadow = next.shadows > 0;
  if (next.shadows > 0) key.shadow.mapSize = next.shadows;
  buildBoard();
}

// ---------------------------------------------------------------- the round
/** A new round (or a theme / look change): the lot rebuilt for its entry and state. */
export function setRound(e: Entry | null, s: State | null, themeId: string): void {
  entry = e;
  state = s;
  theme = Content.THEMES.find((t) => t.id === (themeId || e?.theme)) ?? Content.THEMES[0]!;
  over = false;
  avRng = Rules.rng(1234);
  buildBoard();
}
/** The player's theme choice changed ('' follows the stage). */
export function setTheme(themeId: string): void {
  const t = Content.THEMES.find((x) => x.id === (themeId || entry?.theme)) ?? Content.THEMES[0]!;
  if (t === theme) return;
  theme = t;
  buildBoard();
}
/** The rules state moved on (a slide animates; undo and restarts too). */
export function syncState(s: State, animate: boolean): void {
  state = s;
  syncVehicles(animate);
}
export function setSelected(i: number, roundOver: boolean): void {
  if (i === selected && roundOver === over) return;
  selected = i;
  over = roundOver;
  updateSelectionVisual();
}
export function setReducedMotion(on: boolean): void { reducedMotion = on; }
/** A blocked move: the vehicle jiggles. */
export function flashInvalid(vIdx: number): void {
  const view = views[vIdx];
  if (!view || reducedMotion) return;
  if (!view.shake) view.shakeBaseX = view.mesh.position.x;
  view.shake = 0.25;
}
/** The win: confetti from the exit (reduced motion: none). */
export function celebrate(): void {
  if (reducedMotion || !boardGroup || !look) return;
  const geo = new BoxGeometry(0.08, 0.08, 0.08);
  const count = Math.round(look.budget.confetti * (look.particles === "high" ? 1 : 0.5));
  const mats = theme.palette.map((c) => new MeshBasicMaterial({ color: c }));
  const p = cellToWorld(GRID - 1, Rules.EXIT_ROW);
  for (let i = 0; i < count; i++) {
    const m = new Mesh(geo, mats[i % mats.length]!);
    m.position.set(p.x + 0.8, 0.4, p.z);
    m.layers.set(LAYER_MARK);
    boardGroup.add(m);
    vfx.push({ m, vel: new Vector3((avRng() - 0.2) * 4, avRng() * 5 + 2, (avRng() - 0.5) * 4), life: 1.4 });
  }
}
/** Whether the lot draws (the title, mode and setup screens cover the window). */
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }

// ---------------------------------------------------------------- camera
export interface ViewRect { x: number; y: number; width: number; height: number }
let view: ViewRect = { x: 0, y: 0, width: 1, height: 1 };
let win = { w: 1, h: 1 };
let frameKey = "";
/** main.js fitCamera: pull back along the home direction until the whole lot fits the playfield's aspect. */
function fitCamera(): void {
  camera.aspect = view.width / Math.max(1, view.height);
  const dir = CAM_HOME.pos.clone().sub(CAM_HOME.look);
  const home = dir.length();
  dir.normalize();
  const tanV = Math.tan((camera.fov * PI) / 180 / 2);
  const tanH = tanV * Math.max(0.05, camera.aspect);
  const halfW = (GRID * CELL) / 2 + 1.4; // lot width + parapet
  const halfV = ((GRID * CELL) / 2) * (CAM_HOME.pos.y / home) + 1.0; // depth foreshortened by the tilt
  const dist = Math.max(home, Math.max(halfW / tanH, halfV / tanV));
  camera.position.copy(CAM_HOME.look).addScaledVector(dir, dist);
  camera.lookAt(CAM_HOME.look);
  // the DOM canvas sat between the status bar, rails and tray: the window is the playfield's view, offset
  camera.setViewOffset(view.width, view.height, -view.x, -view.y, win.w, win.h);
  camera.updateProjectionMatrix();
  // fog starts behind the lot at any camera distance, so the board never hazes
  if (scene.fog instanceof Fog) { scene.fog.near = dist + 8; scene.fog.far = dist + 46; }
}
/** The camera reset key: the authored framing again. */
export function resetCamera(): void { frameKey = ""; }

// ---------------------------------------------------------------- picking
const raycaster = new Raycaster();
const groundPlane = new Plane(new Vector3(0, 1, 0), 0);
function cast(x: number, y: number, layer: number): ReturnType<Raycaster["intersectObjects"]> {
  raycaster.setFromCamera(pointerToNdc(x, y), camera);
  raycaster.layers.set(layer);
  return raycaster.intersectObjects(boardGroup ? boardGroup.children : [], true);
}
/** Window pixels → the vehicle there (-1: none). */
export function pickVehicle(x: number, y: number): number {
  if (!renderer.camera) return -1;
  const h = cast(x, y, LAYER_GAME)[0];
  let o: Object3D | null = h ? h.object : null;
  while (o && o.userData.vehicleIndex === undefined) o = o.parent;
  return o ? (o.userData.vehicleIndex as number) : -1;
}
/** Window pixels → the legal-target marker's move there (the selection ring shares the layer). */
export function pickMarker(x: number, y: number): Move | null {
  if (!renderer.camera) return null;
  const h = cast(x, y, LAYER_MARK).find((i) => i.object.userData.move);
  if (h) return h.object.userData.move as Move;
  // The markers are flat discs on the lot: also test the ray's point on their plane against each disc
  // (the raycast missed some discs near the lot's front edge; reported).
  raycaster.setFromCamera(pointerToNdc(x, y), camera);
  const p = new Vector3();
  if (!raycaster.ray.intersectPlane(markerPlane, p)) return null;
  for (const m of markerMeshes) if (Math.hypot(m.position.x - p.x, m.position.z - p.z) <= 0.3) return m.userData.move as Move;
  return null;
}
const markerPlane = new Plane(new Vector3(0, 1, 0), -0.075);
/** Window pixels → board cell coordinates on the lot's plane (for the drag's travel). */
export function pickCell(x: number, y: number): { x: number; y: number } | null {
  if (!renderer.camera) return null;
  raycaster.setFromCamera(pointerToNdc(x, y), camera);
  const hit = new Vector3();
  if (!raycaster.ray.intersectPlane(groundPlane, hit)) return null;
  return { x: hit.x / CELL + (GRID - 1) / 2, y: hit.z / CELL + (GRID - 1) / 2 };
}
/** Board cell (fractional) → window pixels (main.js screenPos). */
export function screenPos(cx: number, cy: number, height = 0): { x: number; y: number } | null {
  if (!renderer.camera) return null;
  const p = cellToWorld(cx, cy);
  const v = new Vector3(p.x, height, p.z).project(camera);
  return { x: ((v.x + 1) / 2) * win.w, y: ((1 - v.y) / 2) * win.h };
}
/** The window rectangle around a vehicle's footprint (for its accessible target). */
export function vehicleRect(v: Vehicle): ViewRect | null {
  if (!renderer.camera) return null;
  const x0 = v.x - 0.4, y0 = v.y - 0.4;
  const x1 = (v.ori === "h" ? v.x + v.len - 1 : v.x) + 0.4, y1 = (v.ori === "v" ? v.y + v.len - 1 : v.y) + 0.4;
  let ax = Infinity, ay = Infinity, bx = -Infinity, by = -Infinity;
  for (const [cx, cy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] as const) {
    for (const hgt of [0, 0.6]) {
      const s = screenPos(cx, cy, hgt);
      if (!s) return null;
      ax = Math.min(ax, s.x); ay = Math.min(ay, s.y); bx = Math.max(bx, s.x); by = Math.max(by, s.y);
    }
  }
  return { x: ax, y: ay, width: bx - ax, height: by - ay };
}

// ---------------------------------------------------------------- per frame
/** Each frame: the framing for the window and the playfield (window px), the slides, jiggles, lift, confetti and ambient motion. */
export function update(dt: number, nowMs: number, w: number, h: number, rect: ViewRect): void {
  const fk = `${w}x${h}:${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
  if (w > 0 && h > 0 && rect.width > 0 && rect.height > 0 && fk !== frameKey) {
    frameKey = fk;
    win = { w, h };
    view = { ...rect };
    fitCamera();
  }
  dt = Math.min(0.05, dt);
  const moving = !reducedMotion;
  const sel = over ? -1 : selected;
  views.forEach((v, i) => {
    if (v.anim) {
      v.anim.t += dt / 0.16;
      const y = v.mesh.position.y;
      if (v.anim.t >= 1) { v.mesh.position.set(v.anim.to.x, y, v.anim.to.z); v.anim = null; }
      else {
        const e = 1 - Math.pow(1 - v.anim.t, 3);
        v.mesh.position.copy(v.anim.from).lerp(v.anim.to, e).setY(y);
      }
    }
    if (v.shake) {
      v.shake -= dt;
      // offset from the stored base so the jiggle never drifts the car
      if (v.shake > 0 && !v.anim) v.mesh.position.x = v.shakeBaseX + Math.sin(nowMs * 0.09) * 0.03 * v.shake;
      if (v.shake <= 0) { v.shake = 0; if (!v.anim) v.mesh.position.x = v.shakeBaseX; }
    }
    // selection pose: the selected vehicle lifts slightly (a gentle idle bob unless reduced motion)
    if (look?.detailed) {
      const target = i === sel ? 0.07 + (moving ? Math.sin(nowMs * 0.004) * 0.025 : 0) : 0;
      v.mesh.position.y += (target - v.mesh.position.y) * Math.min(1, dt * 14);
    } else if (v.mesh.position.y !== 0) v.mesh.position.y = 0;
  });
  for (let i = vfx.length - 1; i >= 0; i--) {
    const p = vfx[i]!;
    p.life -= dt;
    p.m.position.addScaledVector(p.vel, dt);
    p.vel.y -= 9.8 * dt;
    p.m.rotation.x += dt * 5; p.m.rotation.y += dt * 7;
    if (p.life <= 0) { boardGroup?.remove(p.m); vfx.splice(i, 1); }
  }
  if (exitGate) exitGate.material.emissiveIntensity = moving ? 0.55 + Math.sin(nowMs * 0.004) * 0.2 : 0.6;
  if (ambient) {
    ambient.chevrons.forEach((c, i) => { c.material.emissiveIntensity = moving ? 0.5 + 1.2 * Math.max(0, Math.sin(nowMs * 0.005 - i * 0.9)) : 1.1; });
    ambient.beacon.material.emissiveIntensity = moving ? (nowMs % 1600 < 260 ? 4 : 0.35) : 2;
    if (ambient.dust && moving) {
      const a = ambient.dust.geometry.getAttribute("position")!;
      const arr = a.array as Float32Array;
      for (let i = 0; i < a.count; i++) {
        let y = arr[i * 3 + 1]! + dt * (0.08 + (i % 5) * 0.03);
        if (y > 4.4) y = 0.3;
        arr[i * 3 + 1] = y;
        arr[i * 3] = arr[i * 3]! + Math.sin(nowMs * 0.0006 + i) * dt * 0.05;
      }
      a.needsUpdate = true;
    }
  }
}
