"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import { fileKey, lastBefore, type Snapshot, TASK_COLORS, type Timeline, type TLAgent } from "@/lib/agents3d-timeline";
import type { CityLayout } from "@/lib/city-layout";

import type { Clock } from "../clock";
import { OverlayLabel } from "../overlay-label";
import type { Positions } from "../parts";
import type { Selection } from "../scene";
import { type Beat, beatAt, type Doing, doingAt } from "./activity";
import { type Avatar, disposeAvatar, makeAvatar } from "./avatar";
import { lookFor } from "./identity";
import { applyPose, type Pose } from "./poses";
import { realAge } from "../parts";
import { AVATAR_SCALE, BEACON, BOARD, type MiniCities, SEAT_Y, type Seat, seatAt, TABLE, TOWER, type XZ } from "./world";

/** A change of activity shows for at least this long (real ms), so bursts stay readable. */
const MIN_HOLD_MS = 1500;
const S = AVATAR_SCALE;
/** Above the tabletop: the top of a seated avatar's head. */
const HEAD_Y = SEAT_Y + 2.45 * S;
/** Thrown things (messages, flags, commit blocks) are in flight over this part of a beat. */
const THROW = { from: 0.15, to: 0.6 };
const LAPTOP = { w: 3.0, d: 2.0, lid: 1.9 };

type Live = {
  key: string;
  seat: Seat;
  avatar: Avatar;
  chair: THREE.Group;
  laptop: THREE.Group;
  screen: THREE.MeshBasicMaterial;
  base: THREE.MeshStandardMaterial;
  doing: Doing;
  doingSince: number;
};

export type Activity = { doing: Doing; repo: string | null; path: string | null; beat: Beat | null };

/** What each agent is acting out at snapshot time (for labels and the city). */
export function activitiesAt(tl: Timeline, beats: Map<string, Beat[]>, t: number, live: boolean): Map<string, Activity> {
  const out = new Map<string, Activity>();
  for (const a of tl.agents) {
    const d = doingAt(a, t, live);
    out.set(a.key, { doing: d.doing, repo: d.repo, path: d.path, beat: beatAt(beats.get(a.key) ?? [], t)?.beat ?? null });
  }
  return out;
}

/** A session named only by its id (e.g. "46012075") reads as "Agent 4601". */
const unnamed = (a: TLAgent) => /^[0-9a-f-]{6,}$/i.test(a.name) || a.key.includes(a.name);
export const displayName = (a: TLAgent) => (unnamed(a) ? `Agent ${a.name.replace(/-/g, "").slice(0, 4)}` : a.name);

/** Unnamed sessions quiet for this long leave the table. */
const STALE_MS = 30 * 60_000;

/**
 * Who sits at the table at t: every named agent, plus unnamed sessions that
 * were active recently (or are busy now, live). Stable order, as in the timeline.
 */
export function castAt(tl: Timeline, t: number, live: boolean): TLAgent[] {
  return tl.agents.filter((a) => {
    if (!unnamed(a)) return true;
    if (live && a.node.status === "busy") return true;
    const i = lastBefore(a.events, t);
    return i >= 0 && t - a.events[i].ms < STALE_MS;
  });
}

const DOING_TEXT: Record<Doing, string> = {
  type: "typing",
  read: "reading",
  run: "running a command",
  think: "thinking…",
  idle: "idle",
  nap: "napping",
};

// ── Shared furniture ─────────────────────────────────────────────────────────

const chairMat = new THREE.MeshPhysicalMaterial({ color: "#334155", roughness: 0.6, clearcoat: 0.2 });
const chairGeo = {
  seat: new RoundedBoxGeometry(0.95, 0.12, 0.85, 2, 0.05),
  back: new RoundedBoxGeometry(0.95, 0.95, 0.1, 2, 0.05),
  post: new THREE.CylinderGeometry(0.06, 0.06, 1, 10),
  foot: new THREE.CylinderGeometry(0.45, 0.5, 0.06, 20),
};
/** A desk chair, in avatar units (scaled with it), reaching down to the floor. */
function makeChair(): THREE.Group {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, pos: [number, number, number], scale: [number, number, number] = [1, 1, 1]) => {
    const m = new THREE.Mesh(geo, chairMat);
    m.position.set(...pos);
    m.scale.set(...scale);
    m.castShadow = true;
    g.add(m);
  };
  const floor = (-TABLE.h - SEAT_Y) / S;
  add(chairGeo.seat, [0, 0.31, 0.12]);
  add(chairGeo.back, [0, 0.8, -0.42]);
  add(chairGeo.post, [0, (0.25 + floor) / 2, 0.1], [1, 0.25 - floor, 1]);
  add(chairGeo.foot, [0, floor + 0.03, 0.1]);
  g.scale.setScalar(S);
  return g;
}

/** Code lines for the laptop screens: one canvas, a scrolling clone per laptop. */
let codeTex: THREE.CanvasTexture | null = null;
function codeTexture(): THREE.CanvasTexture {
  if (codeTex) return codeTex;
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0b1220";
  g.fillRect(0, 0, 256, 512);
  for (let l = 0; l < 40; l++) {
    const n = (l * 37) % 23;
    g.fillStyle = l % 3 === 0 ? "#ffffff" : "#8a94a6";
    g.fillRect(16 + (n % 4) * 14, 8 + l * 12.6, 50 + ((n * 41) % 150), 6);
  }
  codeTex = new THREE.CanvasTexture(c);
  codeTex.colorSpace = THREE.SRGBColorSpace;
  codeTex.wrapT = THREE.RepeatWrapping;
  codeTex.repeat.set(1, 0.5);
  return codeTex;
}

const laptopGeo = {
  base: new RoundedBoxGeometry(LAPTOP.w, 0.12, LAPTOP.d, 2, 0.05),
  lid: new RoundedBoxGeometry(LAPTOP.w, LAPTOP.lid, 0.08, 2, 0.04),
  screen: new THREE.PlaneGeometry(LAPTOP.w * 0.9, LAPTOP.lid * 0.86),
  keys: new THREE.PlaneGeometry(LAPTOP.w * 0.85, LAPTOP.d * 0.4),
};
const lidMat = new THREE.MeshPhysicalMaterial({ color: "#cfd3da", metalness: 0.3, roughness: 0.35 });
const keysMat = new THREE.MeshStandardMaterial({ color: "#2b2f38", roughness: 0.8 });

/** The agent's own laptop on the table in front of its seat, screen towards it. */
function makeLaptop(seat: Seat): { g: THREE.Group; screen: THREE.MeshBasicMaterial; base: THREE.MeshStandardMaterial } {
  const g = new THREE.Group();
  const base = new THREE.MeshStandardMaterial({ color: "#cfd3da", metalness: 0.3, roughness: 0.35 });
  const b = new THREE.Mesh(laptopGeo.base, base);
  b.position.y = 0.06;
  b.castShadow = b.receiveShadow = true;
  const keys = new THREE.Mesh(laptopGeo.keys, keysMat);
  keys.rotation.x = -Math.PI / 2;
  keys.position.set(0, 0.125, -0.15);
  const lid = new THREE.Group();
  lid.position.set(0, 0.1, LAPTOP.d / 2);
  lid.rotation.x = 0.2; // leaning back, away from the agent
  const shell = new THREE.Mesh(laptopGeo.lid, lidMat);
  shell.position.y = LAPTOP.lid / 2;
  shell.castShadow = true;
  const tex = codeTexture().clone();
  tex.needsUpdate = true;
  const screen = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  const sm = new THREE.Mesh(laptopGeo.screen, screen);
  sm.position.set(0, LAPTOP.lid / 2, -0.045);
  sm.rotation.y = Math.PI; // faces the agent (-z)
  lid.add(shell, sm);
  g.add(b, keys, lid);
  const inward = S * 0.32 + 0.35 + LAPTOP.d / 2;
  g.position.set(seat.x + seat.nx * inward, 0, seat.z + seat.nz * inward);
  g.rotation.y = seat.yaw;
  return { g, screen, base };
}

const SCREEN_COLOR: Record<Doing, string> = { type: "", read: "#94a3b8", run: "#4ade80", think: "#64748b", idle: "#475569", nap: "#1e293b" };

// ── Agents ───────────────────────────────────────────────────────────────────

export function DeskAgents({
  cast,
  snap,
  clock,
  layout,
  mini,
  beats,
  acts,
  colorOf,
  reduced,
  selected,
  onSelect,
  onAgentClick,
  positions,
}: {
  /** The agents at the table (see castAt). */
  cast: TLAgent[];
  snap: Snapshot;
  clock: Clock;
  layout: CityLayout;
  mini: MiniCities;
  beats: Map<string, Beat[]>;
  acts: Map<string, Activity>;
  colorOf: (key: string) => string;
  reduced: boolean;
  selected: Selection | null;
  onSelect: (s: Selection | null) => void;
  onAgentClick?: (key: string) => void;
  positions: React.RefObject<Positions>;
}) {
  const lookKey = cast.map((a) => `${a.key}:${a.name}:${colorOf(a.key)}`).join("|");
  const lives = useMemo(
    () =>
      cast.map((a, i): Live => {
        const seat = seatAt(i);
        const avatar = makeAvatar(lookFor(a.key, a.name, colorOf(a.key)), a.key);
        avatar.root.scale.setScalar(S);
        const lap = makeLaptop(seat);
        return { key: a.key, seat, avatar, chair: makeChair(), laptop: lap.g, screen: lap.screen, base: lap.base, doing: "idle", doingSince: 0 };
      }),
    // Rebuilt only when the cast or their looks change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lookKey],
  );
  useEffect(
    () => () =>
      lives.forEach((l) => {
        disposeAvatar(l.avatar);
        l.screen.map?.dispose();
        l.screen.dispose();
        l.base.dispose();
      }),
    [lives],
  );
  // Where everyone's head is, for the camera and for thrown messages.
  useEffect(() => {
    for (const l of lives) positions.current?.set(l.key, new THREE.Vector3(l.seat.x, HEAD_Y - 0.6 * S, l.seat.z));
  }, [lives, positions]);

  const flying = useRef<THREE.InstancedMesh>(null);
  const confetti = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(
    () => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(), v: new THREE.Vector3(), s: new THREE.Vector3(), c: new THREE.Color(), a: new THREE.Vector3(), b: new THREE.Vector3() }),
    [],
  );

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.1);
    const t = clock.now();
    const real = performance.now();
    const secs = reduced ? 0 : real / 1000;
    let flyN = 0;
    let confettiN = 0;

    lives.forEach((l, i) => {
      const a = cast[i];
      const d = doingAt(a, t, clock.live);
      if (d.doing !== l.doing && real - l.doingSince > MIN_HOLD_MS) {
        l.doing = d.doing;
        l.doingSince = real;
      }
      const b = beatAt(beats.get(l.key) ?? [], t);
      const beat = b?.beat ?? null;
      const k = b?.k ?? 0;
      const thrown = k >= THROW.from;

      // What to look at (body twist) and what flies where.
      let look: XZ | null = null;
      let from: THREE.Vector3 | null = null;
      let to: THREE.Vector3 | null = null;
      let pose: Pose;
      let pk = 0;
      const hand = tmp.a.set(l.seat.x + l.seat.nx * S * 0.6, 0.6 * S, l.seat.z + l.seat.nz * S * 0.6);
      if (beat) {
        switch (beat.kind) {
          case "carry": {
            const p = beat.peer ? positions.current?.get(beat.peer) : undefined;
            if (p) {
              look = p;
              from = hand;
              to = tmp.b.copy(p);
            }
            pose = thrown ? "give" : "carry";
            pk = thrown ? 1 : 0;
            break;
          }
          case "plant":
          case "unplant": {
            const bi = beat.fileKey ? layout.index.get(beat.fileKey) : undefined;
            if (bi !== undefined) {
              const top = mini.top(bi);
              look = top;
              to = tmp.b.set(top.x, top.y, top.z);
              from = hand;
              if (beat.kind === "unplant") [from, to] = [to, from];
            }
            pose = beat.kind;
            pk = beat.kind === "plant" ? (thrown ? 0.8 : 0.2) : k;
            break;
          }
          case "stack":
            look = TOWER;
            from = hand;
            to = tmp.b.set(TOWER.x, 3, TOWER.z);
            pose = "stack";
            pk = thrown ? 0.8 : 0.2;
            break;
          case "wave":
            look = BEACON;
            pose = "wave";
            break;
          default:
            pose = beat.kind;
        }
      } else {
        // Glance at the whiteboard when one of its tasks has just moved there.
        if (snap.tasks.some((x) => x.worker === l.key && !x.guessed && realAge(clock, t, x.since) >= 0 && realAge(clock, t, x.since) < 4000)) look = BOARD;
        pose = l.doing === "type" ? "type" : l.doing === "read" ? "read" : l.doing === "run" ? "run" : l.doing === "nap" ? "nap" : "idle";
      }

      const hop = applyPose(l.avatar, pose, secs + i * 1.7, pk, false, reduced, true);
      // Turn the upper body towards what it throws at or waves to.
      if (look) {
        const ang = Math.atan2(look.x - l.seat.x, look.z - l.seat.z) - l.seat.yaw;
        l.avatar.joints.body.rotation.y = Math.max(-0.9, Math.min(0.9, Math.atan2(Math.sin(ang), Math.cos(ang))));
      }
      l.avatar.root.position.y = hop * 0.35;
      if (beat?.kind === "carry") {
        l.avatar.props.envelopeMat.color.set(beat.color);
        l.avatar.props.envelopeMat.emissive.set(beat.color);
      }

      // The laptop screen: code scrolling in the agent's colour while it types.
      const sc = l.doing === "type" && !beat ? colorOf(l.key) : SCREEN_COLOR[l.doing];
      l.screen.color.set(sc);
      if (l.screen.map && !reduced && (l.doing === "type" || l.doing === "run") && !beat) l.screen.map.offset.y += dt * (l.doing === "type" ? 0.25 : 0.6);
      const isSel = selected?.kind === "agent" && selected.key === l.key;
      l.base.emissive.set(isSel ? colorOf(l.key) : "#000000");
      l.base.emissiveIntensity = isSel ? 0.8 : 0;

      // Thrown things, stateless from the beat's progress: an arc from the hand to the target.
      if (beat && from && to && flying.current && k >= THROW.from && k <= THROW.to && flyN < 32) {
        const f = (k - THROW.from) / (THROW.to - THROW.from);
        const dist = from.distanceTo(to);
        tmp.v.lerpVectors(from, to, f);
        tmp.v.y += Math.sin(Math.PI * f) * (2 + dist * 0.25);
        const size = beat.kind === "stack" ? 1.1 : beat.kind === "carry" ? 0.9 : 0.7;
        tmp.q.setFromEuler(tmp.e.set(reduced ? 0 : f * 6, reduced ? 0 : f * 4, 0));
        tmp.m.compose(tmp.v, tmp.q, tmp.s.set(size, beat.kind === "carry" ? size * 0.6 : size * (beat.kind === "stack" ? 0.4 : 0.7), size * (beat.kind === "carry" ? 0.1 : 1)));
        flying.current.setMatrixAt(flyN, tmp.m);
        flying.current.setColorAt(flyN, tmp.c.set(beat.kind === "carry" ? beat.color : colorOf(l.key)).multiplyScalar(1.6));
        flyN++;
      }

      // Confetti for a cheer.
      if (!reduced && beat?.kind === "cheer" && confetti.current) {
        const age = k * 2.8;
        for (let c = 0; c < 24 && confettiN < 192; c++, confettiN++) {
          const ang = c * 2.39996 + i;
          const sp = 1.6 + (c % 5) * 0.5;
          // Lands on the tabletop rather than falling through it.
          tmp.v.set(l.seat.x + Math.cos(ang) * sp * age * 0.6, Math.max(0.05, HEAD_Y + (5 - 6 * age) * age), l.seat.z + Math.sin(ang) * sp * age * 0.6);
          tmp.q.setFromEuler(tmp.e.set(age * 9 + c, age * 7, c));
          tmp.m.compose(tmp.v, tmp.q, tmp.s.setScalar(1));
          confetti.current.setMatrixAt(confettiN, tmp.m);
          confetti.current.setColorAt(confettiN, tmp.c.set(["#22c55e", "#f59e0b", "#3b82f6", "#ec4899", "#a855f7"][c % 5]));
        }
      }
    });
    for (const [mesh, n] of [
      [flying.current, flyN],
      [confetti.current, confettiN],
    ] as const) {
      if (!mesh) continue;
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  });

  return (
    <group>
      {lives.map((l, i) => {
        const a = cast[i];
        const pick = (e: { stopPropagation: () => void }) => {
          e.stopPropagation();
          if (onAgentClick) onAgentClick(l.key);
          else onSelect({ kind: "agent", key: l.key });
        };
        return (
          <group key={l.key}>
            <group position={[l.seat.x, SEAT_Y, l.seat.z]} rotation-y={l.seat.yaw} onClick={pick}>
              <primitive object={l.avatar.root} />
              <primitive object={l.chair} />
            </group>
            <primitive object={l.laptop} onClick={pick} />
            <OverlayLabel position={[l.seat.x, HEAD_Y + 0.2, l.seat.z]} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
              <DeskLabel
                name={displayName(a)}
                color={colorOf(l.key)}
                act={acts.get(l.key)}
                snapAgent={snap.agents.get(l.key)}
                selected={selected?.kind === "agent" && selected.key === l.key}
              />
            </OverlayLabel>
          </group>
        );
      })}
      <instancedMesh ref={flying} args={[undefined, undefined, 32]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={confetti} args={[undefined, undefined, 192]} frustumCulled={false}>
        <boxGeometry args={[0.18, 0.18, 0.03]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

function DeskLabel({
  name,
  color,
  act,
  snapAgent,
  selected,
}: {
  name: string;
  color: string;
  act: Activity | undefined;
  snapAgent: Snapshot["agents"] extends Map<string, infer A> ? A | undefined : never;
  selected: boolean;
}) {
  const beat = act?.beat;
  const file = act?.path?.split("/").pop();
  const text = beat
    ? `${beat.label}${beat.count > 1 ? ` ×${beat.count}` : ""}`
    : act && act.doing !== "nap"
      ? `${DOING_TEXT[act.doing]}${file && (act.doing === "type" || act.doing === "read") ? ` ${file}` : ""}`
      : "";
  const bubble = beat?.kind === "blocked" ? "?" : act?.doing === "nap" && !beat ? "z z Z" : act?.doing === "think" && !beat ? "…" : null;
  const task = snapAgent?.task;
  return (
    <div style={{ transform: "translateY(-50%)" }} className="flex flex-col items-center gap-0.5">
      {/* Always rendered (hidden when empty), so the label keeps one shape as it changes. */}
      <div
        className={`rounded-full bg-white px-1.5 text-[11px] font-bold leading-4 shadow ${bubble ? "" : "invisible"} ${
          bubble === "?" ? "text-red-500" : "text-slate-500"
        }`}
      >
        {bubble ?? "·"}
      </div>
      <div
        className="whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] shadow"
        style={{ background: "rgba(0,0,0,0.72)", color: "#fff", borderColor: selected ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.15)" }}
      >
        <span className="mr-1 inline-block size-2 rounded-full align-middle" style={{ background: color }} />
        <span className="font-semibold">{name}</span>
        {/* Capped, so neighbours' pills don't run into each other. */}
        <span
          className="ml-1"
          style={{ color: "rgba(255,255,255,0.65)", display: "inline-block", maxWidth: "9.5em", overflow: "hidden", textOverflow: "ellipsis", verticalAlign: "bottom" }}
        >
          {text}
        </span>
      </div>
      <div
        className={`max-w-56 truncate rounded bg-black/70 px-1.5 text-[10px] ${selected && task ? "" : "hidden"}`}
        style={{ color: task ? TASK_COLORS[task.state] : undefined }}
      >
        {task ? `${task.id ?? "task"} · ${task.title}` : ""}
      </div>
    </div>
  );
}

/** Files being typed into right now, coloured by who types them. */
export function editingFiles(tl: Timeline, acts: Map<string, Activity>, colorOf: (k: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of tl.agents) {
    const act = acts.get(a.key);
    if (act?.doing === "type" && !act.beat && act.repo && act.path) out.set(fileKey(act.repo, act.path), colorOf(a.key));
  }
  return out;
}
