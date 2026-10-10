"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";

import type { AgentEvent } from "@/lib/agents3d-types";
import { editor, fileKey, lastBefore, type Snapshot, type Timeline, toolKind } from "@/lib/agents3d-timeline";
import type { CityLayout } from "@/lib/city-layout";
import { LIFT_STOREYS, liftActive, liftAt, TOUCH_HOLD_MS, type TouchKind } from "@/lib/lift";

import { BoltPool, FLASH_MS, tailFade } from "./bolts";
import type { Clock } from "./clock";
import { useWantFrame } from "./frame-governor";
import { ANIM_FPS, editId, keyOf, type Positions, realAge, useSeen } from "./parts";

/** A touched file keeps its bolt this long (real ms) before the linger starts (and its lift: lib/lift.ts). */
const HOLD_MS = TOUCH_HOLD_MS;
/** Message bolts (TASK/STATUS between drones). */
const MSG_MS = 1600;
const FORKS = 3;
const POOL = 64;

/** Where a bolt struck this frame, for the City view to light nearby buildings. */
export type Strike = { x: number; y: number; z: number; color: THREE.Color; k: number };

/** A tool call's id for the "seen" tracker (cached per event with keyOf). */
const callId = (e: AgentEvent & { ms: number }, agent: string) => `${agent}@${e.ms}@${e.tool}`;

/** The bolts' timing curve and strike flash, shared with the Table (bolts.ts). */
export { FLASH_MS, tailFade };

// Scratch vector (module-level: no per-frame allocation).
const vB = new THREE.Vector3();

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
    // One call: the first one counts as "already there at load"; a second would make every past edit fresh.
    seenEv.mark([...tl.agents.flatMap((a) => a.events.map((e) => keyOf(e, (x) => callId(x, a.key)))), ...tl.edits.map((e) => keyOf(e, editId))]);
    seenMsg.mark(tl.messages.map((m) => m.id));
  }, [tl, seenEv, seenMsg]);

  // The bolts and sparks (bolts.ts), sized to the City.
  const pool = useMemo(() => new BoltPool(POOL, scale), [scale]);
  useEffect(() => () => pool.dispose(), [pool]);
  const agentColor = useMemo(() => new Map(tl.agents.map((a) => [a.key, new THREE.Color(a.color)])), [tl]);
  const col = useMemo(() => new THREE.Color(), []);
  const targets = useMemo(() => new Map<string, { age: number; kind: "edit" | "read"; ms: number }>(), []);
  const strikePool = useMemo(() => Array.from({ length: 24 }, () => ({ x: 0, y: 0, z: 0, color: new THREE.Color(), k: 0 })), []);
  const want = useWantFrame();

  useFrame(() => {
    const t = clock.now();
    const live = clock.live;
    const now = performance.now();
    const out = strikes.current;
    if (out) out.length = 0;
    pool.begin();
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
        pool.add(from, vB, color, tg.kind === "edit" ? bright : bright * 0.6, tg.kind, tg.age, fade);

        if (flash > 0.01 && out && out.length < strikePool.length) {
          const sp = strikePool[out.length];
          sp.x = vB.x;
          sp.y = vB.y;
          sp.z = vB.z;
          sp.color.copy(color);
          sp.k = flash;
          out.push(sp);
        }
        if (tg.kind === "edit" && tg.age < FLASH_MS && !reduced) pool.burst(`${a.key}|${k}|${tg.ms}`, vB, color, now);
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
      pool.add(pa, pb, col, 0.45 * (1 - 0.5 * Math.min(1, age / MSG_MS)), "msg", age, tailFade(age, MSG_MS, linger));
    }

    // Draw (active first, newest first); bolts flicker and fade, sparks fall: frames until the last is gone.
    if (pool.draw(now, reduced, linger) || lifting) want(ANIM_FPS);
  });


  return (
    <group>
      {pool.objects.map((o, i) => (
        <primitive key={i} object={o} />
      ))}
    </group>
  );
}
