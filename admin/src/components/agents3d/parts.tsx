"use client";

import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { TASK_COLORS, type Snapshot, type Timeline, type TLCommit, type TLMessage } from "@/lib/agents3d-timeline";

import type { Clock } from "./clock";

/** Live positions of each agent's drone, written by the City view every frame. */
export type Positions = Map<string, THREE.Vector3>;

/** Real-time duration of a message's flight, and how long its trail lingers. */
export const FLIGHT_MS = 2600;
export const TRAIL_MS = 2400;

/**
 * When the client first saw each event id. In live mode data arrives up to a
 * poll late, so an event's animation starts at max(event time, first seen);
 * everything present at the first load counts as old.
 */
class SeenTracker {
  private seen = new Map<string, number>();
  private primed = false;
  mark(ids: Iterable<string>) {
    const now = Date.now();
    for (const id of ids) if (!this.seen.has(id)) this.seen.set(id, this.primed ? now : 0);
    this.primed = true;
  }
  eff(id: string, ms: number, live: boolean) {
    return live ? Math.max(ms, this.seen.get(id) ?? 0) : ms;
  }
}

export function useSeen(): SeenTracker {
  const [tracker] = useState(() => new SeenTracker());
  return tracker;
}

/** Age in real milliseconds of an event at `ms` when the clock reads `t`. */
export const realAge = (clock: Clock, t: number, ms: number) => (t - ms) / (clock.live ? 1 : clock.speed);

/** Messages whose flight or trail is showing at time t (newest last), at most `max`. */
export function activeMessages(tl: Timeline, clock: Clock, t: number, eff: (m: TLMessage) => number, max = 40) {
  const out: { m: TLMessage; age: number }[] = [];
  for (let i = tl.messages.length - 1; i >= 0 && out.length < max; i--) {
    const m = tl.messages[i];
    const age = realAge(clock, t, eff(m));
    if (age < 0) continue;
    // Messages are time-sorted; once far in the past (and not delayed by "seen"), stop.
    if (realAge(clock, t, m.ms) > (FLIGHT_MS + TRAIL_MS) * 40 && age > FLIGHT_MS + TRAIL_MS) break;
    if (age <= FLIGHT_MS + TRAIL_MS) out.push({ m, age });
  }
  return out.reverse();
}

const ARC_POOL = 40;
const ARC_SEG = 40;

/**
 * Light pulses travelling between agents along arcs, tag-coloured. Pooled:
 * fixed meshes and lines updated in place each frame.
 */
export function MessageArcs({
  tl,
  clock,
  positions,
  eff,
  reduced,
}: {
  tl: Timeline;
  clock: Clock;
  positions: React.RefObject<Positions>;
  eff: (m: TLMessage) => number;
  reduced: boolean;
}) {
  const pool = useMemo(
    () =>
      Array.from({ length: ARC_POOL }, () => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((ARC_SEG + 1) * 3), 3));
        const line = new THREE.Line(
          geo,
          new THREE.LineBasicMaterial({ transparent: true, toneMapped: false, depthWrite: false }),
        );
        const head = new THREE.Mesh(
          new THREE.SphereGeometry(0.32, 12, 12),
          new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true }),
        );
        line.visible = head.visible = false;
        line.frustumCulled = false;
        return { line, head };
      }),
    [],
  );
  const curve = useMemo(() => new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()), []);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const col = useMemo(() => new THREE.Color(), []);

  useFrame(() => {
    const t = clock.now();
    const act = activeMessages(tl, clock, t, eff, ARC_POOL);
    pool.forEach((p, i) => {
      const a = act[i];
      const from = a && positions.current?.get(a.m.from);
      const to = a && positions.current?.get(a.m.to);
      if (!a || !from || !to) {
        p.line.visible = p.head.visible = false;
        return;
      }
      const dist = from.distanceTo(to);
      curve.v0.copy(from);
      curve.v2.copy(to);
      curve.v1.copy(from).add(to).multiplyScalar(0.5);
      curve.v1.y += dist * 0.35 + 2;
      const f = reduced ? 1 : Math.min(1, a.age / FLIGHT_MS);
      const fade = a.age > FLIGHT_MS ? 1 - (a.age - FLIGHT_MS) / TRAIL_MS : 1;
      const pos = p.line.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let s = 0; s <= ARC_SEG; s++) {
        curve.getPoint((s / ARC_SEG) * f, tmp);
        pos.setXYZ(s, tmp.x, tmp.y, tmp.z);
      }
      pos.needsUpdate = true;
      p.line.geometry.computeBoundingSphere();
      col.set(a.m.color);
      const lm = p.line.material as THREE.LineBasicMaterial;
      lm.color.copy(col).multiplyScalar(1.6);
      lm.opacity = 0.85 * fade;
      p.line.visible = true;
      const hm = p.head.material as THREE.MeshBasicMaterial;
      hm.color.copy(col).multiplyScalar(3);
      hm.opacity = fade;
      curve.getPoint(f, p.head.position);
      p.head.scale.setScalar(a.age < FLIGHT_MS ? 1 : 1 + (1 - fade) * 1.5);
      p.head.visible = true;
    });
  });

  return (
    <group>
      {pool.map((p, i) => (
        <group key={i}>
          <primitive object={p.line} />
          <primitive object={p.head} />
        </group>
      ))}
    </group>
  );
}

/** Name, current task and last tool floating over an agent. */
export function AgentLabel({
  name,
  color,
  snapAgent,
  live,
  onClick,
}: {
  name: string;
  color: string;
  snapAgent: Snapshot["agents"] extends Map<string, infer A> ? A | undefined : never;
  live: boolean;
  onClick?: () => void;
}) {
  const task = snapAgent?.task;
  return (
    <Html center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
      <div
        onClick={onClick}
        className="pointer-events-auto -translate-y-10 cursor-pointer select-none whitespace-nowrap rounded-md border border-white/15 bg-black/70 px-2 py-1 text-[11px] text-white shadow-lg backdrop-blur"
      >
        <div className="flex items-center gap-1.5 font-semibold">
          <span className="size-2 rounded-full" style={{ background: color, boxShadow: snapAgent?.busy ? `0 0 8px ${color}` : undefined }} />
          {name}
          <span className="font-normal text-white/60">
            {snapAgent?.busy ? (snapAgent.lastTool ?? "busy") : live ? "idle" : "quiet"}
          </span>
        </div>
        {!task && (snapAgent?.managing ?? 0) > 0 && (
          <div className="mt-0.5 text-[10px] text-white/70">dispatching · {snapAgent!.managing} open</div>
        )}
        {task && (
          <div className="mt-0.5 flex max-w-64 items-center gap-1">
            <span className="rounded px-1 font-mono text-[10px]" style={{ background: `${TASK_COLORS[task.state]}33`, color: TASK_COLORS[task.state] }}>
              {task.id ?? "task"} · {task.state.replace("_", " ")}
            </span>
            <span className="truncate text-white/80">{task.title}</span>
          </div>
        )}
      </div>
    </Html>
  );
}

/**
 * Commits stacking into a tower, newest dropping in from above, with an
 * "origin" beacon that flashes when a push is reported.
 */
export function CommitTower({
  commits,
  clock,
  colorOf,
  position,
  reduced,
  label,
  onSelect,
}: {
  commits: TLCommit[];
  clock: Clock;
  colorOf: (node: string) => string;
  position: [number, number, number];
  reduced: boolean;
  label?: string;
  onSelect?: (c: TLCommit) => void;
}) {
  const shown = commits.slice(-48);
  const blocks = useRef<(THREE.Mesh | null)[]>([]);
  const beam = useRef<THREE.Mesh>(null);
  const BLOCK_H = 0.55;

  useFrame(() => {
    const t = clock.now();
    shown.forEach((c, i) => {
      const m = blocks.current[i];
      if (!m) return;
      const age = realAge(clock, t, c.ms);
      const y = i * BLOCK_H + BLOCK_H / 2;
      m.position.y = reduced || age > 1500 || age < 0 ? y : y + (1 - age / 1500) ** 2 * 12;
    });
    if (beam.current) {
      let flash = 0;
      for (const c of commits) {
        if (c.pushedMs == null) continue;
        const age = realAge(clock, t, c.pushedMs);
        if (age >= 0 && age < 3500) flash = Math.max(flash, 1 - age / 3500);
      }
      const mat = beam.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.12 + flash * 0.85;
      mat.color.set("#06b6d4").multiplyScalar(1 + flash * 3);
      beam.current.scale.x = beam.current.scale.z = 1 + flash * 2.5;
    }
  });

  const top = shown.length * BLOCK_H;
  return (
    <group position={position}>
      {shown.map((c, i) => (
        <mesh
          key={c.hash}
          ref={(m) => {
            blocks.current[i] = m;
          }}
          position={[0, i * BLOCK_H + BLOCK_H / 2, 0]}
          onClick={(e) => {
            e.stopPropagation();
            onSelect?.(c);
          }}
        >
          <boxGeometry args={[1.6, BLOCK_H * 0.86, 1.6]} />
          <meshStandardMaterial color={colorOf(c.node)} emissive={colorOf(c.node)} emissiveIntensity={0.5} />
        </mesh>
      ))}
      <mesh ref={beam} position={[0, top + 20, 0]}>
        <cylinderGeometry args={[0.12, 0.12, 40, 8, 1, true]} />
        <meshBasicMaterial color="#06b6d4" transparent toneMapped={false} depthWrite={false} />
      </mesh>
      <mesh position={[0, top + 40.5, 0]}>
        <octahedronGeometry args={[0.8]} />
        <meshBasicMaterial color={new THREE.Color("#06b6d4").multiplyScalar(2)} toneMapped={false} />
      </mesh>
      {label && (
        <Html position={[0, -0.6, 0]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
          <div className="whitespace-nowrap rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white/80">{label}</div>
        </Html>
      )}
    </group>
  );
}

/** Keeps the camera on a moving agent: shifts camera and target by the same delta. */
export function Follow({ positions, followKey, reduced }: { positions: React.RefObject<Positions>; followKey: string | null; reduced: boolean }) {
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null;
  const camera = useThree((s) => s.camera);
  const delta = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    if (!followKey || !controls) return;
    const p = positions.current?.get(followKey);
    if (!p) return;
    // Time-based easing, so it settles at the same pace at any frame rate.
    delta.copy(p).sub(controls.target).multiplyScalar(reduced ? 1 : 1 - Math.exp(-dt * 3.5));
    controls.target.add(delta);
    camera.position.add(delta);
    controls.update();
  });
  return null;
}
