"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import type { TLAgent, TLMessage } from "@/lib/agents3d-timeline";

import type { Clock } from "../clock";
import { useWantFrame } from "../frame-governor";
import { realAge } from "../parts";
import { FLIGHT_MS, flightState, offTable, type P3, planeAt, type PlanePose, stagger, UNFOLD_MS } from "./planes";
import { AVATAR_SCALE, FLOOR_Y, laptopAt, seatAt, TABLE } from "./world";

const S = AVATAR_SCALE;
/** Planes in the air at once. */
const POOL = 24;
/** A plane's size (world units, nose to tail). */
const SIZE = 1.3;
/** Messages older than this (real ms, past the stagger too) can't be flying any more. */
const SPAN = FLIGHT_MS + UNFOLD_MS + 4000;

/** A folded paper plane, nose towards +z, one unit long: two wings and the keel under them. */
const paperGeo = (() => {
  const nose = [0, 0, 0.5];
  const tail = [0, 0, -0.5];
  const left = [-0.42, 0.06, -0.5];
  const right = [0.42, 0.06, -0.5];
  const keel = [0, -0.16, -0.5];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([...nose, ...tail, ...left, ...nose, ...right, ...tail, ...nose, ...keel, ...tail], 3));
  g.computeVertexNormals();
  return g;
})();
/** A band across both wings near the tail, a hair above the paper: the sender's stripe. */
const stripeGeo = (() => {
  // On a wing, the leading edge at z runs out to x = 0.42·(0.5 − z), rising 0.06·(0.5 − z).
  const edge = (z: number, sx: number) => [sx * 0.42 * (0.5 - z), 0.06 * (0.5 - z) + 0.006, z];
  const quad = (sx: number) => {
    const a = [0, 0.006, -0.18];
    const b = edge(-0.18, sx);
    const c = edge(-0.32, sx);
    const d = [0, 0.006, -0.32];
    return [...a, ...b, ...c, ...a, ...c, ...d];
  };
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([...quad(-1), ...quad(1)], 3));
  g.computeVertexNormals();
  return g;
})();

/**
 * Messages between agents as paper planes (T106): from the sender's hands in a
 * gentle arc to the receiver's place at the table, where each unfolds and is
 * gone; to someone not at the table, off its edge. White paper, a stripe in
 * the sender's colour (as the post-its' dot). Pooled and instanced; frames only
 * while one flies. In replay they fly as of the scrubber's time; live, when
 * the message is first seen (`eff`), as the speech bubbles do.
 */
export function DeskPlanes({
  cast,
  messages,
  eff,
  clock,
  colorOf,
  reduced,
}: {
  cast: TLAgent[];
  messages: TLMessage[];
  eff: (id: string, ms: number) => number;
  clock: Clock;
  colorOf: (key: string) => string;
  reduced: boolean;
}) {
  const paper = useRef<THREE.InstancedMesh>(null);
  const stripe = useRef<THREE.InstancedMesh>(null);
  const want = useWantFrame();
  const invalidate = useThree((s) => s.invalidate);
  // Where each seated agent throws from (its hands) and where a plane to it lands (in front of its laptop).
  const spots = useMemo(() => {
    const m = new Map<string, { hand: P3; land: P3 }>();
    cast.forEach((a, i) => {
      const seat = seatAt(i, cast.length);
      const lap = laptopAt(seat);
      m.set(a.key, {
        hand: { x: seat.x + seat.nx * S * 0.6, y: 0.6 * S, z: seat.z + seat.nz * S * 0.6 },
        land: { x: lap.x + seat.nx * 1.6, y: 0.12, z: lap.z + seat.nz * 1.6 },
      });
    });
    return m;
  }, [cast]);
  const tmp = useMemo(
    () => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(0, 0, 0, "YXZ"), p: new THREE.Vector3(), s: new THREE.Vector3(), c: new THREE.Color(), pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 } as PlanePose }),
    [],
  );
  // New messages come with a re-render: draw, so a plane due now takes off.
  useEffect(() => invalidate(), [messages, invalidate]);

  useFrame(() => {
    const now = clock.now();
    const pm = paper.current;
    const sm = stripe.current;
    if (!pm || !sm) return;
    // The recent messages from someone at the table (newest last), and when each takes off.
    const recent: { m: TLMessage; at: number }[] = [];
    for (let n = messages.length - 1; n >= 0; n--) {
      const m = messages[n];
      if (realAge(clock, now, m.ms) > SPAN * 40) break;
      if (!spots.has(m.from)) continue;
      const at = eff(m.id, m.ms);
      if (realAge(clock, now, at) > SPAN) continue;
      recent.push({ m, at });
    }
    const starts = stagger(recent.map(({ m, at }) => ({ id: m.id, from: m.from, at })), 350 * (clock.live ? 1 : clock.speed));
    let n = 0;
    let soonest = Infinity;
    for (const { m } of recent) {
      if (n >= POOL) break;
      const start = starts.get(m.id)!;
      const age = realAge(clock, now, start);
      if (age < 0) {
        soonest = Math.min(soonest, -age);
        continue;
      }
      const st = flightState(age);
      if (!st) continue;
      const from = spots.get(m.from)!.hand;
      const to = spots.get(m.to)?.land ?? offTable(from, TABLE.r, FLOOR_Y);
      const k = st.phase === "fly" ? st.k : 1;
      const p = planeAt(from, to, reduced ? (k < 1 ? k : 1) : k, (m.id.charCodeAt(0) % 7) * 0.9, tmp.pose);
      // Unfolding: it flattens and spreads a little, then shrinks away.
      const u = st.phase === "unfold" ? st.u : 0;
      tmp.e.set(st.phase === "unfold" ? 0 : p.pitch, p.yaw, reduced || st.phase === "unfold" ? 0 : p.roll);
      tmp.q.setFromEuler(tmp.e);
      const grow = SIZE * (1 + 0.4 * Math.min(1, u * 2)) * (u > 0.5 ? 1 - (u - 0.5) * 2 : 1);
      tmp.s.set(grow, SIZE * (1 - u), grow);
      tmp.m.compose(tmp.p.set(p.x, p.y, p.z), tmp.q, tmp.s);
      pm.setMatrixAt(n, tmp.m);
      sm.setMatrixAt(n, tmp.m);
      sm.setColorAt(n, tmp.c.set(colorOf(m.from)));
      n++;
    }
    for (const mesh of [pm, sm]) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    if (n > 0) want(30);
    // A plane waiting its turn (staggered): a frame when it's due.
    else if (soonest < Infinity) want(1000 / Math.max(1, soonest));
  });

  return (
    <group>
      <instancedMesh ref={paper} args={[paperGeo, undefined, POOL]} count={0} frustumCulled={false} castShadow>
        <meshStandardMaterial color="#f8fafc" roughness={0.8} side={THREE.DoubleSide} />
      </instancedMesh>
      <instancedMesh ref={stripe} args={[stripeGeo, undefined, POOL]} count={0} frustumCulled={false}>
        <meshStandardMaterial roughness={0.7} side={THREE.DoubleSide} />
      </instancedMesh>
    </group>
  );
}
