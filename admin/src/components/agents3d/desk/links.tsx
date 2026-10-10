"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

import { fileKey, lastBefore, type Snapshot, type Timeline, type TLAgent, toolKind } from "@/lib/agents3d-timeline";
import type { CityLayout } from "@/lib/city-layout";
import { TOUCH_HOLD_MS } from "@/lib/lift";

import type { Clock } from "../clock";
import { BoltPool, FLASH_MS, tailFade } from "../bolts";
import { useWantFrame } from "../frame-governor";
import { realAge } from "../parts";
import { liftsAt } from "./lifts";
import { laptopTop, type MiniCities, PLATE_H, seatAt } from "./world";

/**
 * From each agent's laptop to what it touches on the mini-cities (T94): the
 * City's lightning (bolts.ts) to the files it edited or read in the last
 * seconds, up to three per agent, newest brightest, edits crackling with
 * branches, a flash and sparks on the roof, held then fading over the linger,
 * ending on the building's roof as lifted (T108); and a steady thin thread to
 * every file it holds (CLAIM), which bolts don't show. A file not laid out as
 * a building links to its nearest enclosing district.
 */

const MAX = 48; // held threads
const SEG = 16; // segments per thread
/** Per agent, bolts to at most this many recently touched files (as in the City). */
const FORKS = 3;
/** Bolts at once on the table. */
const POOL = 32;
/** The sparks' scale on the table (the City's is 1): smaller and slower, to suit the mini-cities. */
const SPARK_SCALE = 0.3;


type Fat = { obj: LineSegments2; pos: Float32Array; col: Float32Array };

function fat(width: number): Fat {
  const pos = new Float32Array(MAX * SEG * 6);
  const col = new Float32Array(MAX * SEG * 6);
  const g = new LineSegmentsGeometry();
  g.setPositions(pos);
  g.setColors(col);
  const mat = new LineMaterial({ linewidth: width, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  mat.toneMapped = false;
  const obj = new LineSegments2(g, mat);
  obj.frustumCulled = false;
  return { obj, pos, col };
}

function flush(f: Fat) {
  const g = f.obj.geometry;
  (g.attributes.instanceStart as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
  (g.attributes.instanceColorStart as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
}

/** Where a file sits on the plates: its building, else the deepest district holding it (cached). */
class Targets {
  private cache = new Map<string, THREE.Vector3 | null>();
  private byRepo = new Map<string, CityLayout["districts"]>();
  constructor(
    private layout: CityLayout,
    private mini: MiniCities,
  ) {
    for (const d of layout.districts) this.byRepo.set(d.repo, [...(this.byRepo.get(d.repo) ?? []), d]);
  }
  get(key: string): THREE.Vector3 | null {
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const { layout, mini } = this;
    let out: THREE.Vector3 | null = null;
    const bi = layout.index.get(key);
    if (bi !== undefined) {
      const t = mini.top(bi);
      out = new THREE.Vector3(t.x, t.y, t.z);
    } else {
      const [repo, path] = key.split("\n");
      const best = (this.byRepo.get(repo) ?? []).filter((d) => path.startsWith(`${d.dir}/`)).sort((a, b) => b.depth - a.depth)[0];
      if (best) {
        const p = mini.at(repo, best.x + best.w / 2, best.z + best.d / 2);
        out = new THREE.Vector3(p.x, PLATE_H + 0.05, p.z);
      }
    }
    this.cache.set(key, out);
    return out;
  }
}


export function DeskLinks({
  cast,
  edits,
  snap,
  clock,
  layout,
  mini,
  linger,
  colorOf,
  reduced,
  lifts,
}: {
  cast: TLAgent[];
  /** Edits seen through file mtimes (made with Bash): they lift their buildings too. */
  edits: Timeline["edits"];
  snap: Snapshot;
  clock: Clock;
  layout: CityLayout;
  mini: MiniCities;
  /** Real ms a touch lingers (fading) after it. */
  linger: number;
  colorOf: (key: string) => string;
  reduced: boolean;
  /** Written each frame, before the mini-cities read it: each building's lift (by layout index), world units. */
  lifts: React.RefObject<Float32Array>;
}) {
  const held = useMemo(() => fat(1.5), []);
  useEffect(
    () => () => {
      held.obj.geometry.dispose();
      (held.obj.material as LineMaterial).dispose();
    },
    [held],
  );
  const pool = useMemo(() => new BoltPool(POOL, SPARK_SCALE), []);
  useEffect(() => () => pool.dispose(), [pool]);
  // Each seat's laptop top, where its bolts and threads start.
  const tops = useMemo(() => cast.map((_, i) => laptopTop(seatAt(i, cast.length))), [cast]);
  // An agent's newest touched files this frame (reused): file, age (real ms), edit or read, and the touch's time.
  const picks = useMemo(() => Array.from({ length: FORKS }, () => ({ key: "", age: 0, edit: false, ms: 0 })), []);

  const targets = useMemo(() => new Targets(layout, mini), [layout, mini]);
  // A file's point, on its building's roof as lifted (a scratch vector: use it before the next call).
  const lifted = useMemo(() => new THREE.Vector3(), []);
  const target = (key: string) => {
    const p = targets.get(key);
    const bi = layout.index.get(key);
    const h = bi === undefined ? 0 : (lifts.current[bi] ?? 0);
    return p && h ? lifted.set(p.x, p.y + h, p.z) : p;
  };

  const col = useMemo(() => new THREE.Color(), []);
  const ctl = useMemo(() => new THREE.Vector3(), []);
  const want = useWantFrame();

  useFrame(() => {
    const t = clock.now();
    const now = performance.now();
    let nh = 0;
    pool.begin();

    // Touched files' buildings lift (lifts.ts), before anything ends on a roof.
    const lifting = liftsAt(lifts.current, layout.index, cast, edits, t, (ms) => realAge(clock, t, ms), linger, reduced);

    // One link: a sagging-up arc (like a cable lifted over the table) from the laptop to the target.
    const write = (f: Fat, n: number, from: THREE.Vector3, to: THREE.Vector3, c: THREE.Color, k: number) => {
      ctl.lerpVectors(from, to, 0.5);
      ctl.y = Math.max(from.y, to.y) + 1.2 + from.distanceTo(to) * 0.12;
      let px = from.x;
      let py = from.y;
      let pz = from.z;
      for (let s = 1; s <= SEG; s++) {
        const u = s / SEG;
        const a = (1 - u) * (1 - u);
        const b = 2 * (1 - u) * u;
        const d = u * u;
        const x = a * from.x + b * ctl.x + d * to.x;
        const y = a * from.y + b * ctl.y + d * to.y;
        const z = a * from.z + b * ctl.z + d * to.z;
        const o = (n * SEG + s - 1) * 6;
        const P = f.pos;
        const C = f.col;
        P[o] = px;
        P[o + 1] = py;
        P[o + 2] = pz;
        P[o + 3] = x;
        P[o + 4] = y;
        P[o + 5] = z;
        C[o] = C[o + 3] = c.r * k;
        C[o + 1] = C[o + 4] = c.g * k;
        C[o + 2] = C[o + 5] = c.b * k;
        px = x;
        py = y;
        pz = z;
      }
    };

    cast.forEach((a, i) => {
      const from = tops[i];
      if (!from) return;
      const color = colorOf(a.key);
      // Held files: steady and thin.
      for (const [k, holders] of snap.holders) {
        if (nh >= MAX || !holders.includes(a.key)) continue;
        const to = target(k);
        if (!to) continue;
        write(held, nh++, from, to, col.set(color), 0.55);
      }
      // Touched files: the newest FORKS distinct ones still holding or lingering; an edit of one in that time makes it an edit.
      let np = 0;
      for (let j = lastBefore(a.events, t); j >= 0; j--) {
        const e = a.events[j];
        const age = realAge(clock, t, e.ms);
        if (age > TOUCH_HOLD_MS + linger) break;
        if (!e.repo || !e.path) continue;
        const kind = toolKind(e.tool);
        if (kind !== "edit" && kind !== "read") continue;
        const key = fileKey(e.repo, e.path);
        let at = -1;
        for (let q = 0; q < np; q++) if (picks[q].key === key) at = q;
        if (at >= 0) {
          if (kind === "edit") picks[at].edit = true;
        } else if (np < FORKS) {
          const pk = picks[np++];
          pk.key = key;
          pk.age = age;
          pk.edit = kind === "edit";
          pk.ms = e.ms;
        }
      }
      col.set(color);
      for (let q = 0; q < np; q++) {
        const pk = picks[q];
        const to = target(pk.key);
        if (!to) continue;
        // As in the City: brighter while active, the newest brightest, a flash after an edit.
        const activeK = 1 - Math.min(1, pk.age / TOUCH_HOLD_MS);
        const fade = tailFade(pk.age, TOUCH_HOLD_MS, linger);
        const flash = !pk.edit ? 0 : pk.age < FLASH_MS ? 1 - (pk.age / FLASH_MS) * 0.5 : 0.5 * tailFade(pk.age, FLASH_MS, linger * 0.35);
        const bright = (q === 0 ? 1 : 0.55) * (0.45 + 0.55 * activeK) + flash * 2;
        pool.add(from, to, col, pk.edit ? bright : bright * 0.6, pk.edit ? "edit" : "read", pk.age, fade);
        if (pk.edit && pk.age < FLASH_MS && !reduced) pool.burst(`${a.key}|${pk.key}|${pk.ms}`, to, col, now);
      }
    });
    // Unused threads collapse to nothing.
    held.pos.fill(0, nh * SEG * 6);
    flush(held);
    // Bolts flicker and fade, sparks fall, buildings rise and settle: frames until the last is done.
    if (pool.draw(now, reduced, linger) || lifting) want(30);
  });

  return (
    <group>
      <primitive object={held.obj} />
      {pool.objects.map((o, i) => (
        <primitive key={i} object={o} />
      ))}
    </group>
  );
}
