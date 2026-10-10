"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

import type { AgentEvent } from "@/lib/agents3d-types";
import { editor, fileKey, lastBefore, type Snapshot, type Timeline, toolKind } from "@/lib/agents3d-timeline";
import type { CityLayout } from "@/lib/city-layout";
import { LIFT_STOREYS, liftActive, liftAt, TOUCH_HOLD_MS, type TouchKind } from "@/lib/lift";

import type { Clock } from "./clock";
import { useWantFrame } from "./frame-governor";
import { ANIM_FPS, editId, keyOf, type Positions, realAge, useSeen } from "./parts";

/** A touched file keeps its bolt this long (real ms) before the linger starts (and its lift: lib/lift.ts). */
const HOLD_MS = TOUCH_HOLD_MS;
/** The strike flash after an Edit. */
export const FLASH_MS = 450;
/** Message bolts (TASK/STATUS between drones). */
const MSG_MS = 1600;
const FORKS = 3;
const POOL = 64;
const SEG = 32; // power of two: midpoint displacement levels
const BRANCHES = 2;
const BRANCH_SEG = 8;
const BURSTS = 16;
const SPARKS = 22;
const GRAVITY = -9;
/** Screen-space widths in px. */
const CORE_PX = 3.5;
const GLOW_PX = 12;
const BRANCH_PX = 2;
const READ_PX = 2;
/** Electric blue-white for bolt cores. */
const CORE_COLOR = new THREE.Color("#dbeafe");

/** Where a bolt struck this frame, for the City view to light nearby buildings. */
export type Strike = { x: number; y: number; z: number; color: THREE.Color; k: number };

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

/** A tool call's id for the "seen" tracker (cached per event with keyOf). */
const callId = (e: AgentEvent & { ms: number }, agent: string) => `${agent}@${e.ms}@${e.tool}`;

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
const vB = new THREE.Vector3();
const dir = new THREE.Vector3();
const perp = new THREE.Vector3();
const tmp = new THREE.Vector3();

/** Jagged path from a to b into `out` by midpoint displacement; `rough` scales the jaggedness. */
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

/**
 * Lightning from each drone to the files it is touching right now: forks to
 * up to three files touched in the last few seconds (newest brightest), a
 * calm thin arc for reads, a crackling bolt with side branches for edits, a
 * flash and a spark burst on the roof at each Edit; dim bolts between drones
 * when a TASK/STATUS passes. Bolts are pixel-width lines (white-blue core
 * drawn on top, wide glow in the agent's colour) from a fixed pool, their
 * buffers rewritten in place. Fresh strikes are reported through `strikes`.
 */
export function Lightning({
  tl,
  snap,
  clock,
  layout,
  positions,
  reduced,
  scale,
  strikes,
  linger,
  lifts,
  storey = 1,
}: {
  tl: Timeline;
  snap: Snapshot;
  clock: Clock;
  layout: CityLayout;
  positions: React.RefObject<Positions>;
  reduced: boolean;
  scale: number;
  strikes: React.RefObject<Strike[]>;
  /** After an operation ends, a bolt stays this long (real ms) while fading out. */
  linger: number;
  /** Written each frame: how high each building (by layout index) is lifted by its touches (T108), in world units. */
  lifts?: Float32Array;
  /** A storey, in world units (a lift is 1 or 1.5 of them). */
  storey?: number;
}) {
  const seenEv = useSeen();
  const seenMsg = useSeen();
  useEffect(() => {
    seenEv.mark(tl.agents.flatMap((a) => a.events.map((e) => keyOf(e, (x) => callId(x, a.key)))));
    seenEv.mark(tl.edits.map((e) => keyOf(e, editId)));
    seenMsg.mark(tl.messages.map((m) => m.id));
  }, [tl, seenEv, seenMsg]);

  const bolts = useMemo<Bolt[]>(
    () =>
      Array.from({ length: POOL }, () => {
        const core = fat(SEG + 1, CORE_PX, true);
        const glow = fat(SEG + 1, GLOW_PX, false, core.obj.geometry as LineSegmentsGeometry, core.segs);
        return {
          core,
          glow,
          branches: Array.from({ length: BRANCHES }, () => fat(BRANCH_SEG + 1, BRANCH_PX, true)),
          pts: new Float32Array((SEG + 1) * 3),
          nextRegen: 0,
        };
      }),
    [],
  );
  const sparks = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(BURSTS * SPARKS * 3), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(BURSTS * SPARKS * 3), 3));
    const mat = new THREE.PointsMaterial({
      size: 0.45,
      vertexColors: true,
      transparent: true,
      toneMapped: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 10;
    return pts;
  }, []);
  const bursts = useMemo<Burst[]>(
    () => Array.from({ length: BURSTS }, () => ({ born: -1e9, x: 0, y: 0, z: 0, color: new THREE.Color(), vel: new Float32Array(SPARKS * 3) })),
    [],
  );
  const state = useMemo(() => ({ nextBurst: 0, burstKeys: new Set<string>() }), []);
  const agentColor = useMemo(() => new Map(tl.agents.map((a) => [a.key, new THREE.Color(a.color)])), [tl]);
  const col = useMemo(() => new THREE.Color(), []);
  const targets = useMemo(() => new Map<string, { age: number; kind: "edit" | "read"; ms: number }>(), []);
  const strikePool = useMemo(() => Array.from({ length: 24 }, () => ({ x: 0, y: 0, z: 0, color: new THREE.Color(), k: 0 })), []);
  // Bolt candidates for this frame (reused objects), drawn in priority order.
  const cands = useMemo(
    () =>
      Array.from({ length: POOL * 2 }, () => ({
        from: new THREE.Vector3(),
        to: new THREE.Vector3(),
        color: new THREE.Color(),
        bright: 0,
        kind: "edit" as "edit" | "read" | "msg",
        age: 0,
        fade: 1,
      })),
    [],
  );
  const order = useMemo<number[]>(() => [], []);
  const want = useWantFrame();

  useFrame(() => {
    const t = clock.now();
    const live = clock.live;
    const now = performance.now();
    const out = strikes.current;
    if (out) out.length = 0;
    let n = 0;
    // Touched files' buildings lift (the highest lift of their touches; reduced motion: no easing).
    if (lifts) lifts.fill(0);
    let lifting = false;
    const lift = (fk: string, kind: TouchKind, age: number) => {
      const bi = lifts ? layout.index.get(fk) : undefined;
      if (bi === undefined || !lifts) return;
      lifting = true;
      const h = (reduced ? (age <= HOLD_MS + linger ? LIFT_STOREYS[kind] : 0) : liftAt(kind, age, linger)) * storey;
      if (h > lifts[bi]) lifts[bi] = h;
    };

    const enqueue = (
      from: THREE.Vector3,
      to: THREE.Vector3,
      color: THREE.Color,
      bright: number,
      kind: "edit" | "read" | "msg",
      age: number,
      fade: number,
    ) => {
      if (n >= cands.length || bright * fade <= 0.001) return;
      const c = cands[n++];
      c.from.copy(from);
      c.to.copy(to);
      c.color.copy(color);
      c.bright = bright;
      c.kind = kind;
      c.age = age;
      c.fade = fade;
    };

    for (const a of tl.agents) {
      const from = positions.current?.get(a.key);
      if (!from || !snap.agents.get(a.key)) continue;
      targets.clear();
      const end = lastBefore(a.events, t);
      for (let i = end, k = 0; i >= 0 && k < 40; i--, k++) {
        const e = a.events[i];
        if (!e.repo || !e.path) continue;
        const kind = toolKind(e.tool);
        if (kind !== "edit" && kind !== "read") continue;
        const age = realAge(clock, t, seenEv.eff(keyOf(e, (x) => callId(x, a.key)), e.ms, live));
        if (!liftActive(age, linger)) continue;
        const fk = fileKey(e.repo, e.path);
        lift(fk, kind, age);
        if (age > HOLD_MS + linger) continue; // (still settling: lifted, no bolt)
        const prev = targets.get(fk);
        if (!prev || age < prev.age) targets.set(fk, { age, kind: kind === "edit" || prev?.kind === "edit" ? "edit" : "read", ms: e.ms });
      }
      // Edits seen through file mtimes (made with Bash), credited to this agent.
      for (let i = lastBefore(tl.edits, t), k = 0; i >= 0 && k < 120; i--, k++) {
        const e = tl.edits[i];
        if (e.node && e.node !== a.key) continue;
        const age = realAge(clock, t, seenEv.eff(keyOf(e, editId), e.ms, live));
        if (!liftActive(age, linger)) continue;
        if (!e.node && editor(tl, snap, e) !== a.key) continue;
        lift(e.fileKey, "edit", age);
        if (age > HOLD_MS + linger) continue;
        const prev = targets.get(e.fileKey);
        if (!prev || age < prev.age) targets.set(e.fileKey, { age, kind: "edit", ms: e.ms });
      }
      if (targets.size === 0) continue;

      const color = agentColor.get(a.key)!;
      const list = [...targets.entries()].sort((x, y) => x[1].age - y[1].age).slice(0, FORKS);
      list.forEach(([k, tg], rank) => {
        const bi = layout.index.get(k);
        if (bi === undefined) return;
        const b = layout.buildings[bi];
        // (on the roof as lifted)
        vB.set(b.x, b.h + (lifts?.[bi] ?? 0), b.z);
        const active = 1 - Math.min(1, tg.age / HOLD_MS);
        const fade = tailFade(tg.age, HOLD_MS, linger);
        // The strike flash: full, then a short hold-and-fade tail.
        const flash =
          tg.kind !== "edit"
            ? 0
            : tg.age < FLASH_MS
              ? 1 - (tg.age / FLASH_MS) * 0.5
              : 0.5 * tailFade(tg.age, FLASH_MS, linger * 0.35);
        const bright = (rank === 0 ? 1 : 0.55) * (0.45 + 0.55 * active) + flash * 2;
        enqueue(from, vB, color, tg.kind === "edit" ? bright : bright * 0.6, tg.kind, tg.age, fade);

        if (flash > 0.01 && out && out.length < strikePool.length) {
          const sp = strikePool[out.length];
          sp.x = vB.x;
          sp.y = vB.y;
          sp.z = vB.z;
          sp.color.copy(color);
          sp.k = flash;
          out.push(sp);
        }
        if (tg.kind === "edit" && tg.age < FLASH_MS && !reduced) {
          const key = `${a.key}|${k}|${tg.ms}`;
          if (!state.burstKeys.has(key)) {
            state.burstKeys.add(key);
            if (state.burstKeys.size > 500) state.burstKeys.clear();
            const s = bursts[state.nextBurst];
            state.nextBurst = (state.nextBurst + 1) % BURSTS;
            s.born = now;
            s.x = vB.x;
            s.y = vB.y;
            s.z = vB.z;
            s.color.copy(color);
            for (let j = 0; j < SPARKS; j++) {
              const ang = Math.random() * Math.PI * 2;
              const sp = (1.5 + Math.random() * 3.5) * scale;
              s.vel[j * 3] = Math.cos(ang) * sp;
              s.vel[j * 3 + 1] = (2 + Math.random() * 4) * scale;
              s.vel[j * 3 + 2] = Math.sin(ang) * sp;
            }
          }
        }
      });
    }

    // Dim bolts between drones when a TASK / STATUS passes.
    for (let i = lastBefore(tl.messages, t), k = 0; i >= 0 && k < 30; i--, k++) {
      const m = tl.messages[i];
      if (m.tag !== "TASK" && m.tag !== "STATUS") continue;
      const age = realAge(clock, t, seenMsg.eff(m.id, m.ms, live));
      if (age < 0 || age > MSG_MS + linger) continue;
      const pa = positions.current?.get(m.from);
      const pb = positions.current?.get(m.to);
      if (!pa || !pb) continue;
      col.set(m.color);
      enqueue(pa, pb, col, 0.45 * (1 - 0.5 * Math.min(1, age / MSG_MS)), "msg", age, tailFade(age, MSG_MS, linger));
    }

    // Draw: active bolts first (newest first), then fading ones (newest first), so when
    // the pool is full the oldest fading bolts are the ones dropped.
    order.length = n;
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((x, y) => {
      const fx = cands[x].fade < 1 ? 1 : 0;
      const fy = cands[y].fade < 1 ? 1 : 0;
      return fx - fy || cands[x].age - cands[y].age;
    });
    const used = Math.min(n, POOL);
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
        // Keep the shape but pin the ends to the (moving) drone and roof.
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
    for (let i = used; i < POOL; i++) {
      const b = bolts[i];
      b.core.obj.visible = false;
      b.glow.obj.visible = false;
      b.branches.forEach((bb) => (bb.obj.visible = false));
    }

    // Spark bursts: ballistic points; they fade over 0.9 s plus a share of the linger.
    const life = 0.9 + (linger / 1000) * 0.25;
    const pos = sparks.geometry.getAttribute("position") as THREE.BufferAttribute;
    const cols = sparks.geometry.getAttribute("color") as THREE.BufferAttribute;
    const pa = pos.array as Float32Array;
    const ca = cols.array as Float32Array;
    let sparking = false;
    for (let s = 0; s < BURSTS; s++) {
      const bu = bursts[s];
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
        pa[o + 1] = bu.y + bu.vel[j * 3 + 1] * age + 0.5 * GRAVITY * scale * age * age;
        pa[o + 2] = bu.z + bu.vel[j * 3 + 2] * age;
        const k = (1 - smooth(age / life)) * 3;
        ca[o] = Math.min(4, bu.color.r * k + 0.6 * k);
        ca[o + 1] = Math.min(4, bu.color.g * k + 0.6 * k);
        ca[o + 2] = Math.min(4, bu.color.b * k + 0.6 * k);
      }
    }
    pos.needsUpdate = true;
    cols.needsUpdate = true;
    (sparks.material as THREE.PointsMaterial).size = 0.45 * scale;
    // Bolts flicker and fade, sparks fall: frames until the last is gone.
    if (n > 0 || sparking || lifting) want(ANIM_FPS);
  });

  useEffect(
    () => () => {
      for (const b of bolts) {
        b.core.obj.geometry.dispose();
        for (const f of [b.core, b.glow, ...b.branches]) f.mat.dispose();
        for (const br of b.branches) br.obj.geometry.dispose();
      }
      sparks.geometry.dispose();
      (sparks.material as THREE.Material).dispose();
    },
    [bolts, sparks],
  );

  return (
    <group>
      {bolts.map((b, i) => (
        <group key={i}>
          <primitive object={b.glow.obj} />
          <primitive object={b.core.obj} />
          {b.branches.map((br, k) => (
            <primitive key={k} object={br.obj} />
          ))}
        </group>
      ))}
      <primitive object={sparks} />
    </group>
  );
}
