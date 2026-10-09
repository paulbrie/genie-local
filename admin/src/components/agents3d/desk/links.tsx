"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

import { fileKey, lastBefore, type Snapshot, type TLAgent, toolKind } from "@/lib/agents3d-timeline";
import type { CityLayout } from "@/lib/city-layout";

import type { Clock } from "../clock";
import { laptopTop, type MiniCities, PLATE_H, seatAt } from "./world";

/**
 * Threads from each agent's laptop to what it touches on the mini-cities: a
 * steady thin line to every file it holds (CLAIM), and a brighter, pulsing one
 * to files it edited or read in the last moments, fading over the linger time.
 * A file not laid out as a building links to its nearest enclosing district.
 */

const MAX = 48; // links per kind
const SEG = 16; // segments per link
/** A touch stays at full strength this long (real ms) before the linger fade. */
const ACTIVE_MS = 1500;
/** Per agent, at most this many recently touched files. */
const PER_AGENT = 5;

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
      if (best) out = new THREE.Vector3(mini.ox + (best.x + best.w / 2) * mini.s, PLATE_H + 0.05, mini.oz + (best.z + best.d / 2) * mini.s);
    }
    this.cache.set(key, out);
    return out;
  }
}

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export function DeskLinks({
  cast,
  snap,
  clock,
  layout,
  mini,
  linger,
  colorOf,
  reduced,
}: {
  cast: TLAgent[];
  snap: Snapshot;
  clock: Clock;
  layout: CityLayout;
  mini: MiniCities;
  /** Real ms a touch lingers (fading) after it. */
  linger: number;
  colorOf: (key: string) => string;
  reduced: boolean;
}) {
  const held = useMemo(() => fat(1.5), []);
  const active = useMemo(() => fat(5), []);
  const sparks = useRef<THREE.InstancedMesh>(null);
  const halos = useRef<THREE.InstancedMesh>(null);
  useEffect(
    () => () => {
      for (const f of [held, active]) {
        f.obj.geometry.dispose();
        (f.obj.material as LineMaterial).dispose();
      }
    },
    [held, active],
  );

  const targets = useMemo(() => new Targets(layout, mini), [layout, mini]);
  const target = (key: string) => targets.get(key);

  const col = useMemo(() => new THREE.Color(), []);
  const ctl = useMemo(() => new THREE.Vector3(), []);
  const p = useMemo(() => new THREE.Vector3(), []);
  const m4 = useMemo(() => new THREE.Matrix4(), []);

  useFrame(() => {
    const t = clock.now();
    const scale = clock.live ? 1 : clock.speed;
    const windowMs = (ACTIVE_MS + linger) * scale;
    const real = performance.now() / 1000;
    let nh = 0;
    let na = 0;
    let ns = 0;
    let nh2 = 0;

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
      const from = laptopTop(seatAt(i, cast.length));
      const color = colorOf(a.key);
      // Held files: steady and thin.
      for (const [k, holders] of snap.holders) {
        if (nh >= MAX || !holders.includes(a.key)) continue;
        const to = target(k);
        if (!to) continue;
        write(held, nh++, from, to, col.set(color), 0.55);
      }
      // Recently touched files: bright, fading after the linger.
      const seen = new Set<string>();
      for (let j = lastBefore(a.events, t); j >= 0 && na < MAX && seen.size < PER_AGENT; j--) {
        const e = a.events[j];
        if (t - e.ms > windowMs) break;
        if (!e.repo || !e.path) continue;
        const kind = toolKind(e.tool);
        if (kind !== "edit" && kind !== "read") continue;
        const key = fileKey(e.repo, e.path);
        if (seen.has(key)) continue;
        seen.add(key);
        const to = target(key);
        if (!to) continue;
        const age = (t - e.ms) / scale;
        const fade = age <= ACTIVE_MS ? 1 : 1 - smooth((age - ACTIVE_MS) / Math.max(1, linger));
        const pulse = reduced ? 1 : 0.8 + 0.2 * Math.sin(real * 8 + j);
        write(active, na++, from, to, col.set(color), (kind === "edit" ? 2.6 : 1.2) * fade * pulse);
        // Lights running along an edit's thread, towards the file.
        if (kind === "edit" && !reduced && sparks.current) {
          ctl.lerpVectors(from, to, 0.5);
          ctl.y = Math.max(from.y, to.y) + 1.2 + from.distanceTo(to) * 0.12;
          for (let n = 0; n < 3 && ns < MAX * 3; n++) {
            const u = (real * 0.6 + i * 0.37 + n / 3) % 1;
            p.set(0, 0, 0)
              .addScaledVector(from, (1 - u) * (1 - u))
              .addScaledVector(ctl, 2 * (1 - u) * u)
              .addScaledVector(to, u * u);
            sparks.current.setMatrixAt(ns, m4.makeScale(fade, fade, fade).setPosition(p));
            sparks.current.setColorAt(ns++, col.set(color).multiplyScalar(3));
          }
        }
        // A soft glow on the file's building while it's being worked on.
        if (halos.current && nh2 < MAX) {
          const r = (kind === "edit" ? 1.1 : 0.75) * fade * (reduced ? 1 : 0.85 + 0.15 * Math.sin(real * 5 + j));
          halos.current.setMatrixAt(nh2, m4.makeScale(r, r * 0.7, r).setPosition(to));
          halos.current.setColorAt(nh2++, col.set(color).multiplyScalar(kind === "edit" ? 1.4 : 0.8));
        }
      }
    });
    // Unused links collapse to nothing.
    held.pos.fill(0, nh * SEG * 6);
    active.pos.fill(0, na * SEG * 6);
    flush(held);
    flush(active);
    for (const [mesh, n] of [
      [sparks.current, ns],
      [halos.current, nh2],
    ] as const) {
      if (!mesh) continue;
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  });

  return (
    <group>
      <primitive object={held.obj} />
      <primitive object={active.obj} />
      <instancedMesh ref={sparks} args={[undefined, undefined, MAX * 3]} frustumCulled={false}>
        <sphereGeometry args={[0.2, 10, 8]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={halos} args={[undefined, undefined, MAX]} frustumCulled={false}>
        <sphereGeometry args={[1, 20, 14]} />
        <meshBasicMaterial toneMapped={false} transparent opacity={0.35} blending={THREE.AdditiveBlending} depthWrite={false} />
      </instancedMesh>
    </group>
  );
}
