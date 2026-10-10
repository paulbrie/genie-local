/**
 * Lightning bolts, shared by Agents City and the Table (T94): a fixed pool of
 * pixel-width bolts (a white-blue core drawn on top, a wide glow in the
 * agent's colour, side branches for edits) and spark bursts. Each frame the
 * scene queues the bolts it wants (`begin`, `add`, `burst`) and `draw` lays
 * them into the pool: active ones first, newest first, so when the pool is
 * full the oldest fading ones are dropped. Buffers are rewritten in place: no
 * allocation per frame. No React: mount `objects` as primitives.
 */
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

export type BoltKind = "edit" | "read" | "msg";

/** The strike flash after an Edit (real ms). */
export const FLASH_MS = 450;

const SEG = 32; // power of two: midpoint displacement levels
const BRANCHES = 2;
const BRANCH_SEG = 8;
const BURSTS = 16;
const SPARKS = 22;
const GRAVITY = -9;
/** Screen-space widths in px (they don't scale with the scene). */
const CORE_PX = 3.5;
const GLOW_PX = 12;
const BRANCH_PX = 2;
const READ_PX = 2;
/** Electric blue-white for bolt cores. */
const CORE_COLOR = new THREE.Color("#dbeafe");

/** A fat (pixel-width) line of `n` points; `segs` is its live segment buffer, updated in place. */
type Fat = { obj: LineSegments2; mat: LineMaterial; segs: Float32Array; n: number };

function fat(n: number, width: number, onTop: boolean, geo?: LineSegmentsGeometry, segs?: Float32Array): Fat {
  const buf = segs ?? new Float32Array((n - 1) * 6);
  const g = geo ?? new LineSegmentsGeometry();
  if (!geo) g.setPositions(buf);
  const mat = new LineMaterial({
    linewidth: width,
    transparent: true,
    depthWrite: false,
    // Cores and branches draw over buildings and the edit beam so they never merge into them.
    depthTest: !onTop,
    blending: THREE.AdditiveBlending,
  });
  mat.toneMapped = false;
  const obj = new LineSegments2(g, mat);
  obj.frustumCulled = false;
  obj.visible = false;
  if (onTop) obj.renderOrder = 10;
  return { obj, mat, segs: buf, n };
}

type Bolt = {
  core: Fat;
  glow: Fat; // shares the core's geometry
  branches: Fat[];
  pts: Float32Array; // (SEG+1)*3 jagged path
  nextRegen: number;
};

type Burst = { born: number; x: number; y: number; z: number; color: THREE.Color; vel: Float32Array };

type Cand = { from: THREE.Vector3; to: THREE.Vector3; color: THREE.Color; bright: number; kind: BoltKind; age: number; fade: number };

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * 1 while an effect is active (age ≤ activeMs); then, over `linger` ms, it holds
 * for the first 40% and eases out to 0. With no linger it ends at activeMs.
 */
export function tailFade(age: number, activeMs: number, linger: number): number {
  if (age <= activeMs) return 1;
  if (linger <= 0) return 0;
  const x = (age - activeMs) / linger;
  return x >= 1 ? 0 : 1 - smooth((x - 0.4) / 0.6);
}

// Scratch vectors (module-level: no per-frame allocation).
const vA = new THREE.Vector3();
const dir = new THREE.Vector3();
const perp = new THREE.Vector3();
const tmp = new THREE.Vector3();

/** Jagged path from a to b into `out` by midpoint displacement; `rough` scales the jaggedness (with the distance, so any scene's scale works). */
function jag(out: Float32Array, a: THREE.Vector3, b: THREE.Vector3, rough: number) {
  out[0] = a.x;
  out[1] = a.y;
  out[2] = a.z;
  out[SEG * 3] = b.x;
  out[SEG * 3 + 1] = b.y;
  out[SEG * 3 + 2] = b.z;
  let amp = a.distanceTo(b) * 0.18 * rough;
  for (let step = SEG; step > 1; step >>= 1) {
    const half = step >> 1;
    for (let i = 0; i < SEG; i += step) {
      const i0 = i * 3;
      const i1 = (i + step) * 3;
      const im = (i + half) * 3;
      dir.set(out[i1] - out[i0], out[i1 + 1] - out[i0 + 1], out[i1 + 2] - out[i0 + 2]).normalize();
      perp.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
      perp.addScaledVector(dir, -perp.dot(dir)).normalize().multiplyScalar((Math.random() - 0.5) * 2 * amp);
      out[im] = (out[i0] + out[i1]) / 2 + perp.x;
      out[im + 1] = (out[i0 + 1] + out[i1 + 1]) / 2 + perp.y;
      out[im + 2] = (out[i0 + 2] + out[i1 + 2]) / 2 + perp.z;
    }
    amp *= 0.55;
  }
}

/** Points → the fat line's segment buffer (p0p1, p1p2, …). */
function writeSegs(f: Fat, pts: Float32Array) {
  const s = f.segs;
  for (let i = 0; i < f.n - 1; i++) {
    s[i * 6] = pts[i * 3];
    s[i * 6 + 1] = pts[i * 3 + 1];
    s[i * 6 + 2] = pts[i * 3 + 2];
    s[i * 6 + 3] = pts[i * 3 + 3];
    s[i * 6 + 4] = pts[i * 3 + 4];
    s[i * 6 + 5] = pts[i * 3 + 5];
  }
  (f.obj.geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
}

const branchPts = new Float32Array((BRANCH_SEG + 1) * 3);

/** A short jagged side branch off the bolt at point `at`. */
function branch(f: Fat, pts: Float32Array, at: number, len: number) {
  vA.set(pts[at * 3], pts[at * 3 + 1], pts[at * 3 + 2]);
  dir.set(pts[(at + 1) * 3] - vA.x, pts[(at + 1) * 3 + 1] - vA.y, pts[(at + 1) * 3 + 2] - vA.z).normalize();
  tmp.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
  dir.lerp(tmp, 0.7).normalize();
  for (let i = 0; i <= BRANCH_SEG; i++) {
    const d = (i / BRANCH_SEG) * len;
    const j = i === 0 ? 0 : len * 0.14;
    branchPts[i * 3] = vA.x + dir.x * d + (Math.random() - 0.5) * j;
    branchPts[i * 3 + 1] = vA.y + dir.y * d + (Math.random() - 0.5) * j;
    branchPts[i * 3 + 2] = vA.z + dir.z * d + (Math.random() - 0.5) * j;
  }
  writeSegs(f, branchPts);
}

export class BoltPool {
  /** Mount these (as primitives) once. */
  readonly objects: THREE.Object3D[];
  private readonly bolts: Bolt[];
  private readonly cands: Cand[];
  private readonly order: number[] = [];
  private n = 0;
  private readonly sparks: THREE.Points;
  private readonly bursts: Burst[];
  private nextBurst = 0;
  private readonly burstKeys = new Set<string>();

  /** `size` bolts at most at once; `scale` sizes the sparks (their spread, fall and point size) to the scene. */
  constructor(
    private readonly size: number,
    private readonly scale: number,
  ) {
    this.bolts = Array.from({ length: size }, () => {
      const core = fat(SEG + 1, CORE_PX, true);
      const glow = fat(SEG + 1, GLOW_PX, false, core.obj.geometry as LineSegmentsGeometry, core.segs);
      return {
        core,
        glow,
        branches: Array.from({ length: BRANCHES }, () => fat(BRANCH_SEG + 1, BRANCH_PX, true)),
        pts: new Float32Array((SEG + 1) * 3),
        nextRegen: 0,
      };
    });
    this.cands = Array.from({ length: size * 2 }, () => ({
      from: new THREE.Vector3(),
      to: new THREE.Vector3(),
      color: new THREE.Color(),
      bright: 0,
      kind: "edit" as BoltKind,
      age: 0,
      fade: 1,
    }));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(BURSTS * SPARKS * 3), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(BURSTS * SPARKS * 3), 3));
    const mat = new THREE.PointsMaterial({
      size: 0.45 * scale,
      vertexColors: true,
      transparent: true,
      toneMapped: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.sparks = new THREE.Points(geo, mat);
    this.sparks.frustumCulled = false;
    this.sparks.renderOrder = 10;
    this.bursts = Array.from({ length: BURSTS }, () => ({ born: -1e9, x: 0, y: 0, z: 0, color: new THREE.Color(), vel: new Float32Array(SPARKS * 3) }));
    this.objects = [...this.bolts.flatMap((b) => [b.glow.obj, b.core.obj, ...b.branches.map((br) => br.obj)]), this.sparks];
  }

  /** Starts a frame's queue. */
  begin() {
    this.n = 0;
  }

  /** Queues a bolt from `from` to `to` (copied): its brightness, kind, age (real ms) and fade (0..1). */
  add(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color, bright: number, kind: BoltKind, age: number, fade: number) {
    if (this.n >= this.cands.length || bright * fade <= 0.001) return;
    const c = this.cands[this.n++];
    c.from.copy(from);
    c.to.copy(to);
    c.color.copy(color);
    c.bright = bright;
    c.kind = kind;
    c.age = age;
    c.fade = fade;
  }

  /** A spark burst at `at`, once per `key` (an edit's strike). */
  burst(key: string, at: THREE.Vector3, color: THREE.Color, now: number) {
    if (this.burstKeys.has(key)) return;
    this.burstKeys.add(key);
    if (this.burstKeys.size > 500) this.burstKeys.clear();
    const s = this.bursts[this.nextBurst];
    this.nextBurst = (this.nextBurst + 1) % BURSTS;
    s.born = now;
    s.x = at.x;
    s.y = at.y;
    s.z = at.z;
    s.color.copy(color);
    for (let j = 0; j < SPARKS; j++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = (1.5 + Math.random() * 3.5) * this.scale;
      s.vel[j * 3] = Math.cos(ang) * sp;
      s.vel[j * 3 + 1] = (2 + Math.random() * 4) * this.scale;
      s.vel[j * 3 + 2] = Math.sin(ang) * sp;
    }
  }

  /** Lays the queued bolts into the pool and moves the sparks; true while anything shows (ask for frames). */
  draw(now: number, reduced: boolean, linger: number): boolean {
    const { cands, order, bolts } = this;
    const n = this.n;
    order.length = n;
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((x, y) => {
      const fx = cands[x].fade < 1 ? 1 : 0;
      const fy = cands[y].fade < 1 ? 1 : 0;
      return fx - fy || cands[x].age - cands[y].age;
    });
    const used = Math.min(n, this.size);
    for (let i = 0; i < used; i++) {
      const c = cands[order[i]];
      const b = bolts[i];
      const f = c.fade;
      const rough = c.kind === "read" ? 0.35 : c.kind === "msg" ? 1.4 : 1;
      // Flicker slows as the bolt fades.
      const hz = (c.kind === "read" ? 6 : 14) * Math.max(0.15, f);
      if (reduced) {
        jag(b.pts, c.from, c.to, 0); // static: straight, no flicker
      } else if (now >= b.nextRegen) {
        jag(b.pts, c.from, c.to, rough);
        b.nextRegen = now + 1000 / hz;
        if (c.kind === "edit")
          b.branches.forEach((br) =>
            branch(br, b.pts, 4 + Math.floor(Math.random() * (SEG - 10)), c.from.distanceTo(c.to) * (0.12 + Math.random() * 0.14)),
          );
      } else {
        // Keep the shape but pin the ends to the (moving) source and roof.
        b.pts[0] = c.from.x;
        b.pts[1] = c.from.y;
        b.pts[2] = c.from.z;
        b.pts[SEG * 3] = c.to.x;
        b.pts[SEG * 3 + 1] = c.to.y;
        b.pts[SEG * 3 + 2] = c.to.z;
      }
      const flick = reduced ? 1 : 1 + (Math.random() * 0.6 - 0.3) * f;
      const br = c.bright * f;
      writeSegs(b.core, b.pts);
      // Core: blue-white, tinted a little toward the agent; glow: the agent's colour.
      b.core.mat.color.copy(CORE_COLOR).lerp(c.color, 0.15).multiplyScalar(br * flick * 3.2);
      b.core.mat.opacity = Math.min(1, (0.4 + c.bright) * f);
      b.core.mat.linewidth = c.kind === "read" ? READ_PX : CORE_PX;
      b.core.obj.visible = true;
      b.glow.obj.visible = c.kind !== "read";
      b.glow.mat.color.copy(c.color).multiplyScalar(br * flick * 1.6);
      b.glow.mat.opacity = Math.min(0.6, 0.45 * br);
      b.branches.forEach((bb) => {
        bb.obj.visible = c.kind === "edit" && !reduced && f > 0.5 && Math.random() > 0.2;
        bb.mat.color.copy(CORE_COLOR).lerp(c.color, 0.4).multiplyScalar(br * flick * 2.2);
        bb.mat.opacity = Math.min(1, 0.8 * br);
      });
    }
    for (let i = used; i < this.size; i++) {
      const b = bolts[i];
      b.core.obj.visible = false;
      b.glow.obj.visible = false;
      b.branches.forEach((bb) => (bb.obj.visible = false));
    }

    // Spark bursts: ballistic points; they fade over 0.9 s plus a share of the linger.
    const life = 0.9 + (linger / 1000) * 0.25;
    const pos = this.sparks.geometry.getAttribute("position") as THREE.BufferAttribute;
    const cols = this.sparks.geometry.getAttribute("color") as THREE.BufferAttribute;
    const pa = pos.array as Float32Array;
    const ca = cols.array as Float32Array;
    let sparking = false;
    for (let s = 0; s < BURSTS; s++) {
      const bu = this.bursts[s];
      const age = (now - bu.born) / 1000;
      const alive = age >= 0 && age < life;
      if (alive) sparking = true;
      for (let j = 0; j < SPARKS; j++) {
        const o = (s * SPARKS + j) * 3;
        if (!alive) {
          ca[o] = ca[o + 1] = ca[o + 2] = 0;
          continue;
        }
        pa[o] = bu.x + bu.vel[j * 3] * age;
        pa[o + 1] = bu.y + bu.vel[j * 3 + 1] * age + 0.5 * GRAVITY * this.scale * age * age;
        pa[o + 2] = bu.z + bu.vel[j * 3 + 2] * age;
        const k = (1 - smooth(age / life)) * 3;
        ca[o] = Math.min(4, bu.color.r * k + 0.6 * k);
        ca[o + 1] = Math.min(4, bu.color.g * k + 0.6 * k);
        ca[o + 2] = Math.min(4, bu.color.b * k + 0.6 * k);
      }
    }
    pos.needsUpdate = true;
    cols.needsUpdate = true;
    return n > 0 || sparking;
  }

  dispose() {
    for (const b of this.bolts) {
      b.core.obj.geometry.dispose();
      for (const f of [b.core, b.glow, ...b.branches]) f.mat.dispose();
      for (const br of b.branches) br.obj.geometry.dispose();
    }
    this.sparks.geometry.dispose();
    (this.sparks.material as THREE.Material).dispose();
  }
}
