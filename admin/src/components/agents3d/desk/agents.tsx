"use client";

import { type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import { fileKey, lastBefore, type Snapshot, TASK_COLORS, type Timeline, type TLAgent, type TLMessage } from "@/lib/agents3d-timeline";
import type { CityLayout } from "@/lib/city-layout";

import type { Clock } from "../clock";
import { useStableHandler, useWantFrame } from "../frame-governor";
import { OverlayLabel } from "../overlay-label";
import type { Positions } from "../parts";
import type { Selection } from "../scene";
import { asksUser, type Beat, beatAt, type Doing, doingAt, gazeAt, headCue, waveAt } from "./activity";
import { type Avatar, disposeAvatar, makeAvatar } from "./avatar";
import { lookFor } from "./identity";
import { applyPose, DANCES, idlePose, isDance, type Pose, THINK_POSES } from "./poses";
import { makeThoughtCloud, type ThoughtCloud } from "./thought";
import { realAge } from "../parts";
import { AVATAR_SCALE, BEACON, BOARD, LAPTOP, laptopAt, type MiniCities, SEAT_Y, type Seat, seatAt, TABLE, TOWER, type XZ } from "./world";

/** A change of activity shows for at least this long (real ms), so bursts stay readable. */
const MIN_HOLD_MS = 1500;
const S = AVATAR_SCALE;
/** Above the tabletop: the top of a seated avatar's head. */
const HEAD_Y = SEAT_Y + 2.45 * S;
/** Thrown things (messages, flags, commit blocks) are in flight over this part of a beat. */
const THROW = { from: 0.15, to: 0.6 };
/** Messages also fly as envelopes, alongside the speech bubbles. */
const THROW_MESSAGES = true;
/** A pose change blends over this long (real ms). */
const BLEND_MS = 500;
/**
 * Frames on demand: asked for while anyone works, plays a beat, changes pose or turns.
 * An idle table is a still picture (idle agents hold their pose without sway or
 * breathing); a change the clock alone brings (a nap, the next idle pose, a held
 * change of activity) draws just the frames it needs.
 */
const BUSY_FPS = 30;
/** Idle, napping or waiting, with nothing playing: the agent holds still. */
const calmDoing = (d: Doing) => d === "idle" || d === "nap" || d === "wait";

/**
 * What the agents show at t as far as the clock alone changes it (no new data,
 * no camera): their activity, a beat starting or ending, the idle variant and
 * a glance at the whiteboard. A tick that changes this asks for a frame.
 */
function clockSig(cast: TLAgent[], beats: Map<string, Beat[]>, snap: Snapshot, clock: Clock, real: number): string {
  return cast
    .map((a) => {
      const d = doingAt(a, snap.t, snap.live);
      const b = d.asleep || d.doing === "wait" ? null : beatAt(beats.get(a.key) ?? [], snap.t);
      const idle = d.doing === "idle" || d.doing === "nap" ? idlePose(hash(a.key), real, d.doing === "nap", d.asleep) : "";
      const glance = snap.tasks.some((x) => x.worker === a.key && !x.guessed && realAge(clock, snap.t, x.since) >= 0 && realAge(clock, snap.t, x.since) < 4000);
      return `${d.doing}${d.asleep ? "z" : ""}:${b ? b.beat.start : ""}:${idle}:${glance ? "g" : ""}`;
    })
    .join("|");
}
/** At most this many speech bubbles per agent, newest on top. */
const BUBBLES = 1;

/** The joints a pose sets, flattened, so a change of pose can blend from where the body was. */
const JOINTS = 20;
function readJoints(a: Avatar, o: Float32Array) {
  const j = a.joints;
  let n = 0;
  o[n++] = j.body.position.y;
  for (const g of [j.body, j.head, j.armL, j.armR, j.legL, j.legR]) {
    o[n++] = g.rotation.x;
    o[n++] = g.rotation.y;
    o[n++] = g.rotation.z;
  }
  o[n++] = j.legL.position.y;
}
function blendJoints(a: Avatar, from: Float32Array, to: Float32Array, k: number) {
  const j = a.joints;
  const v = (i: number) => from[i] + (to[i] - from[i]) * k;
  let n = 0;
  j.body.position.y = v(n++);
  for (const g of [j.body, j.head, j.armL, j.armR, j.legL, j.legR]) g.rotation.set(v(n++), v(n++), v(n++));
  j.legL.position.y = j.legR.position.y = v(n++);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export type Bubble = { id: string; head: string; gist: string; color: string; side: "left" | "center" | "right"; opacity: number };

/** A speech bubble stays this long (real ms) plus the Linger, fading out over its last second. */
const BUBBLE_MS = 8000;

/** "TASK T56 · TASK: T56 Fix the thing" → the tag line and a short gist. */
function bubbleText(label: string, tag: string | null, to: string): { head: string; gist: string } {
  const i = label.indexOf(" · ");
  const head = ((i >= 0 ? label.slice(0, i) : tag ?? "note").trim() || "note")
    .replace(/[.,:;]+$/, "")
    // "CLAIM admin/src/…/scene.tsx" → "CLAIM scene.tsx"
    .replace(/\S*\/(\S+)/g, "$1");
  let gist = (i >= 0 ? label.slice(i + 3) : label).replace(/\s+/g, " ").trim();
  // Drop a repeated "TASK: T38" / "ACK T38." lead-in and "(after …)" notes.
  gist = gist.replace(/^[A-Z]{2,}:?\s*(T\d+)?[.:,]?\s*/, "").replace(/^\([^)]*\)\s*/, "");
  if (gist.length > 44) gist = `${gist.slice(0, 43)}…`;
  return { head: `${head} → ${to}`, gist };
}

type Live = {
  key: string;
  seat: Seat;
  avatar: Avatar;
  chair: THREE.Group;
  laptop: THREE.Group;
  /** The laptop's lid (closes for a nap) and how open it is, 0..1. */
  lid: THREE.Group;
  lidOpen: number;
  /** The thought cloud over its head while it thinks. */
  cloud: ThoughtCloud;
  /** The thinking posture of the current spell, and when the spell began. */
  thinkPose: Pose;
  thinkSince: number;
  screen: THREE.MeshBasicMaterial;
  base: THREE.MeshStandardMaterial;
  doing: Doing;
  /** Idle past SLEEP_AFTER_MS: holds the nap, no beats, until it acts again. */
  asleep: boolean;
  doingSince: number;
  /** Pose blending: the last pose, the joints before this frame, and the blend's start. */
  pose: Pose | null;
  prev: Float32Array;
  from: Float32Array | null;
  blendT0: number;
  cur: Float32Array;
  /** Upper-body turn towards a target, eased. */
  twist: number;
  /** The head's extra turn and tilt towards whoever it waits on (eased). */
  gazeY: number;
  gazeX: number;
  /** Per agent, so idle variants and gestures don't run in step. */
  seed: number;
};

export type Activity = { doing: Doing; repo: string | null; path: string | null; beat: Beat | null };

/** What each agent is acting out at snapshot time (for labels and the city). */
export function activitiesAt(tl: Timeline, beats: Map<string, Beat[]>, t: number, live: boolean): Map<string, Activity> {
  const out = new Map<string, Activity>();
  for (const a of tl.agents) {
    const d = doingAt(a, t, live);
    const still = d.asleep || d.doing === "wait";
    out.set(a.key, { doing: d.doing, repo: d.repo, path: d.path, beat: still ? null : (beatAt(beats.get(a.key) ?? [], t)?.beat ?? null) });
  }
  return out;
}

/** A session named only by its id (e.g. "46012075") reads as "Agent 4601". */
const unnamed = (a: TLAgent) => /^[0-9a-f-]{6,}$/i.test(a.name) || a.key.includes(a.name);
export const displayName = (a: TLAgent) => (unnamed(a) ? `Agent ${a.name.replace(/-/g, "").slice(0, 4)}` : a.name);

/** Guest sessions quiet for this long leave the table. */
const STALE_MS = 30 * 60_000;

/** A guest at t: a session nobody named (a default or an id) that was active recently, or is busy now, live. */
function guestAt(a: TLAgent, t: number, live: boolean): boolean {
  if (!a.node.guest) return false;
  if (live && a.node.status === "busy") return true;
  const i = lastBefore(a.events, t);
  return i >= 0 && t - a.events[i].ms < STALE_MS;
}

/** The guests that could sit at the table at t (what "Show guests" would add). */
export const guestsAt = (tl: Timeline, t: number, live: boolean) => tl.agents.filter((a) => guestAt(a, t, live));

/**
 * Who sits at the table at t: every named agent (one per name, as the model
 * merges a name's sessions), plus the guests if shown. Stable order, as in the timeline.
 */
export function castAt(tl: Timeline, t: number, live: boolean, guests: boolean): TLAgent[] {
  return tl.agents.filter((a) => !a.node.guest || (guests && guestAt(a, t, live)));
}

const IDLE_TEXT: Partial<Record<Pose, string>> = { sip: "coffee break", pencil: "fiddling with a pencil", stretch: "stretching", idle: "idle", nap: "" };

const DOING_TEXT: Record<Doing, string> = {
  type: "typing",
  read: "reading",
  run: "running a command",
  think: "thinking…",
  idle: "idle",
  nap: "napping",
  wait: "waiting for you",
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
function makeLaptop(seat: Seat): { g: THREE.Group; lid: THREE.Group; screen: THREE.MeshBasicMaterial; base: THREE.MeshStandardMaterial } {
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
  const at = laptopAt(seat);
  g.position.set(at.x, 0, at.z);
  g.rotation.y = seat.yaw;
  return { g, lid, screen, base };
}

const SCREEN_COLOR: Record<Doing, string> = { type: "", read: "#94a3b8", run: "#4ade80", think: "#64748b", idle: "#475569", nap: "#1e293b", wait: "#fbbf24" };

// ── Agents ───────────────────────────────────────────────────────────────────

export function DeskAgents({
  cast,
  messages,
  linger,
  eff,
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
  /** The timeline's messages, for speech bubbles. */
  messages: TLMessage[];
  /** Real ms effects linger after their operation (the toolbar's Linger). */
  linger: number;
  /** When a message's animation is due (live: when it was first seen). */
  eff: (id: string, ms: number) => number;
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
        const seat = seatAt(i, cast.length);
        const avatar = makeAvatar(lookFor(a.key, a.name, colorOf(a.key)), a.key);
        avatar.root.scale.setScalar(S);
        const lap = makeLaptop(seat);
        return {
          key: a.key,
          seat,
          avatar,
          chair: makeChair(),
          laptop: lap.g,
          screen: lap.screen,
          lid: lap.lid,
          lidOpen: 1,
          cloud: makeThoughtCloud(),
          thinkPose: "think",
          thinkSince: -1,
          base: lap.base,
          doing: "idle",
          asleep: false,
          doingSince: 0,
          pose: null,
          prev: new Float32Array(JOINTS),
          from: null,
          blendT0: 0,
          cur: new Float32Array(JOINTS),
          twist: 0,
          gazeY: 0,
          gazeX: 0,
          seed: hash(a.key),
        };
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
        l.cloud.dispose();
        l.base.dispose();
      }),
    [lives],
  );
  // Where everyone's head is, for the camera and for thrown messages.
  useEffect(() => {
    for (const l of lives) positions.current?.set(l.key, new THREE.Vector3(l.seat.x, HEAD_Y - 0.6 * S, l.seat.z));
  }, [lives, positions]);

  const camera = useThree((s) => s.camera);
  const wantFrame = useWantFrame();
  const invalidate = useThree((s) => s.invalidate);
  // Each tick (a render at snapshot rate): a frame only if the clock changed what shows.
  const sig = useRef("");
  useEffect(() => {
    const next = clockSig(cast, beats, snap, clock, performance.now());
    if (next !== sig.current) {
      sig.current = next;
      invalidate();
    }
  });
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
    let busy = false;
    // The soonest change the clock alone brings (a held change of activity, a wave), in real ms from now.
    let nextMs = Infinity;

    lives.forEach((l, i) => {
      const a = cast[i];
      const d = doingAt(a, t, clock.live);
      // Waking, and starting or ending a wait, skip the hold: they show at once.
      const now = l.asleep || l.doing === "wait" || d.doing === "wait";
      if ((d.doing !== l.doing || d.asleep !== l.asleep) && (now || real - l.doingSince > MIN_HOLD_MS)) {
        l.doing = d.doing;
        l.asleep = d.asleep;
        l.doingSince = real;
      } else if (d.doing !== l.doing || d.asleep !== l.asleep) nextMs = Math.min(nextMs, MIN_HOLD_MS - (real - l.doingSince) + 1);
      // Asleep or waiting for its user, nothing plays (no dances or throws) until it acts.
      const b = l.asleep || l.doing === "wait" ? null : beatAt(beats.get(l.key) ?? [], t);
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
          case "cheer":
            // A happy dance; agents finishing in the same second get different moves.
            pose = DANCES[(Math.floor(beat.start / 1000) * 31 + i) % DANCES.length];
            pk = k;
            break;
          default:
            pose = beat.kind;
        }
      } else {
        // Glance at the whiteboard when one of its tasks has just moved there.
        if (!l.asleep && snap.tasks.some((x) => x.worker === l.key && !x.guessed && realAge(clock, t, x.since) >= 0 && realAge(clock, t, x.since) < 4000)) look = BOARD;
        // Waiting on a prompt: look up at the user, through the camera.
        if (gazeAt(l.doing) === "camera") look = camera.position;
        // Idle: coffee, a pencil, a stretch or just sitting (and naps when idle long), per agent.
        if (l.doing === "idle" || l.doing === "nap") pose = idlePose(l.seed, real, l.doing === "nap", l.asleep);
        else if (l.doing === "think") {
          // A posture per thinking spell, picked at random (per agent, per spell).
          if (l.thinkSince !== l.doingSince) {
            l.thinkSince = l.doingSince;
            l.thinkPose = THINK_POSES[hash(`${l.key}@${Math.floor(l.doingSince)}`) % THINK_POSES.length];
          }
          pose = l.thinkPose;
        } else if (asksUser(l.doing, d.tool)) {
          // Asking its user a question: a wave now and then (waveAt), still in between; a permission prompt just waits.
          const w = waveAt(l.seed, l.doingSince, real);
          pose = w.waving ? "hail" : "wait";
          nextMs = Math.min(nextMs, w.inMs + 1);
        } else pose = l.doing;
      }

      // The laptop closes before a nap and opens again before work: reach for the lid first.
      const wantLid = pose === "nap" ? 0 : 1;
      if (Math.abs(l.lidOpen - wantLid) > 0.12 && !beat && !reduced) {
        pose = "give";
        pk = 1;
      }
      l.lidOpen = reduced ? wantLid : l.lidOpen + Math.sign(wantLid - l.lidOpen) * Math.min(Math.abs(wantLid - l.lidOpen), dt * 2);
      l.lid.rotation.x = -Math.PI / 2 + 0.03 + (Math.PI / 2 + 0.17) * l.lidOpen;
      const calm = !beat && calmDoing(l.doing) && pose !== "hail";
      if (!calm || l.lidOpen !== wantLid) busy = true;

      // Blend into a new pose from wherever the joints were.
      readJoints(l.avatar, l.prev);
      if (pose !== l.pose) {
        if (l.pose !== null && !reduced) {
          l.from = l.from ?? new Float32Array(JOINTS);
          l.from.set(l.prev);
          l.blendT0 = real;
        }
        l.pose = pose;
      }
      const hop = applyPose(l.avatar, pose, secs + (l.seed % 1000) / 100, pk, false, reduced || calm, true);
      if (l.from && real - l.blendT0 < BLEND_MS) {
        readJoints(l.avatar, l.cur);
        const x = (real - l.blendT0) / BLEND_MS;
        blendJoints(l.avatar, l.from, l.cur, x * x * (3 - 2 * x));
        busy = true;
      }
      // Turn the upper body towards what it throws at, waves to or glances at (eased).
      // Looking up at the camera, the head does most of the turn and tilts up; the body follows a little.
      let want = 0;
      let gazeY = 0;
      let gazeX = 0;
      if (look) {
        const ang = Math.atan2(look.x - l.seat.x, look.z - l.seat.z) - l.seat.yaw;
        const turn = Math.atan2(Math.sin(ang), Math.cos(ang));
        if (look === camera.position) {
          want = Math.max(-0.45, Math.min(0.45, turn * 0.4));
          gazeY = Math.max(-0.9, Math.min(0.9, turn - want));
          const up = Math.atan2(camera.position.y - HEAD_Y, Math.hypot(look.x - l.seat.x, look.z - l.seat.z));
          gazeX = -Math.max(-0.2, Math.min(0.55, up));
        } else want = Math.max(-0.9, Math.min(0.9, turn));
      }
      const ease = reduced ? 1 : Math.min(1, dt * 6);
      l.twist += (want - l.twist) * ease;
      l.gazeY += (gazeY - l.gazeY) * ease;
      l.gazeX += (gazeX - l.gazeX) * ease;
      l.avatar.joints.body.rotation.y += l.twist;
      l.avatar.joints.head.rotation.y += l.gazeY;
      l.avatar.joints.head.rotation.x += l.gazeX;
      if (Math.abs(want - l.twist) + Math.abs(gazeY - l.gazeY) + Math.abs(gazeX - l.gazeX) > 1e-3) busy = true;
      // Dances stand up on the chair (their lift is in avatar units); other hops stay small.
      l.avatar.root.position.y = isDance(pose) ? hop * S : hop * 0.35;
      // The thought cloud: in while thinking, out otherwise, facing the camera.
      l.cloud.target = THINK_POSES.includes(pose) ? 1 : 0;
      l.cloud.update(secs + (l.seed % 100) / 10, dt, reduced);
      if (l.cloud.fading) busy = true;
      l.cloud.group.rotation.y = Math.atan2(camera.position.x - l.seat.x, camera.position.z - l.seat.z);
      if (beat?.kind === "carry") {
        l.avatar.props.envelopeMat.color.set(beat.color);
        l.avatar.props.envelopeMat.emissive.set(beat.color);
      }

      // The laptop screen: code scrolling in the agent's colour while it types.
      const sc = l.doing === "type" && !beat ? colorOf(l.key) : SCREEN_COLOR[l.doing];
      l.screen.color.set(sc).multiplyScalar(l.lidOpen);
      if (l.screen.map && !reduced && (l.doing === "type" || l.doing === "run") && !beat) l.screen.map.offset.y += dt * (l.doing === "type" ? 0.25 : 0.6);
      const isSel = selected?.kind === "agent" && selected.key === l.key;
      l.base.emissive.set(isSel ? colorOf(l.key) : "#000000");
      l.base.emissiveIntensity = isSel ? 0.8 : 0;

      // Thrown things, stateless from the beat's progress: an arc from the hand to the target.
      if (beat && from && to && flying.current && k >= THROW.from && k <= THROW.to && flyN < 32 && (THROW_MESSAGES || beat.kind !== "carry")) {
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
    if (busy || flyN > 0 || confettiN > 0) wantFrame(BUSY_FPS);
    else if (nextMs < Infinity) wantFrame(1000 / Math.max(1, nextMs));
  });

  // Speech bubbles: each agent's newest message, for BUBBLE_MS + linger (re-derived at snapshot rate); a newer one replaces it.
  const bubbles = new Map<string, Bubble[]>();
  {
    const seatOf = new Map(lives.map((l) => [l.key, l.seat]));
    const nameOf = new Map(cast.map((a) => [a.key, displayName(a)]));
    const showMs = BUBBLE_MS + linger;
    const pa = new THREE.Vector3();
    const pb = new THREE.Vector3();
    for (let n = messages.length - 1; n >= 0; n--) {
      const m = messages[n];
      const age = realAge(clock, snap.t, eff(m.id, m.ms));
      if (age < 0) continue;
      // Time-sorted: once far in the past (and not delayed by "first seen"), stop.
      if (age > showMs && realAge(clock, snap.t, m.ms) > showMs * 40) break;
      const from = seatOf.get(m.from);
      const to = seatOf.get(m.to);
      if (age > showMs || !from || !to) continue;
      const list = bubbles.get(m.from) ?? [];
      if (list.length >= BUBBLES) continue;
      pa.set(from.x, HEAD_Y, from.z).project(camera);
      pb.set(to.x, HEAD_Y, to.z).project(camera);
      const dx = pb.x - pa.x;
      list.push({
        id: m.id,
        ...bubbleText(m.label, m.tag, nameOf.get(m.to) ?? "?"),
        color: m.color,
        side: dx < -0.04 ? "left" : dx > 0.04 ? "right" : "center",
        opacity: Math.min(1, (showMs - age) / 1000),
      });
      bubbles.set(m.from, list);
    }
  }

  // One handler for every agent (named by key on what was clicked), so re-renders don't redraw.
  const pick = useStableHandler((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const key = e.eventObject.name;
    if (onAgentClick) onAgentClick(key);
    else onSelect({ kind: "agent", key });
  });

  return (
    <group>
      {lives.map((l, i) => {
        const a = cast[i];
        return (
          <group key={l.key}>
            <group name={l.key} position={[l.seat.x, SEAT_Y, l.seat.z]} rotation-y={l.seat.yaw} onClick={pick}>
              <primitive object={l.avatar.root} />
              <primitive object={l.chair} />
            </group>
            <primitive object={l.laptop} name={l.key} onClick={pick} />
            {/* the thought cloud, over the head, turned to the camera each frame */}
            <primitive object={l.cloud.group} position={[l.seat.x, HEAD_Y - 0.15 * S, l.seat.z]} scale={S * 0.55} />
            <OverlayLabel position={[l.seat.x, HEAD_Y + 0.2, l.seat.z]} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
              <DeskLabel
                name={a.node.guest ? `${displayName(a)} (guest)` : displayName(a)}
                color={colorOf(l.key)}
                act={acts.get(l.key)}
                snapAgent={snap.agents.get(l.key)}
                selected={selected?.kind === "agent" && selected.key === l.key}
                bubbles={bubbles.get(l.key) ?? []}
                idle={l.doing === "idle" || l.doing === "nap" ? idlePose(l.seed, performance.now(), l.doing === "nap", l.asleep) : null}
                // Neighbours' bubbles at alternating heights, so they don't sit on each other.
                bubbleLift={(i % 2) * 56}
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
  bubbles,
  bubbleLift,
  idle,
}: {
  name: string;
  color: string;
  act: Activity | undefined;
  snapAgent: Snapshot["agents"] extends Map<string, infer A> ? A | undefined : never;
  selected: boolean;
  bubbles: Bubble[];
  bubbleLift: number;
  /** The idle variant being acted out, if idle. */
  idle: Pose | null;
}) {
  const beat = act?.beat;
  const file = act?.path?.split("/").pop();
  const text = beat
    ? `${beat.label}${beat.count > 1 ? ` ×${beat.count}` : ""}`
    : idle
      ? (IDLE_TEXT[idle] ?? "")
      : act
      ? `${DOING_TEXT[act.doing]}${file && (act.doing === "type" || act.doing === "read") ? ` ${file}` : ""}`
      : "";
  const bubble = headCue(act?.doing, beat?.kind, idle === "nap");
  const task = snapAgent?.task;
  return (
    <div style={{ transform: "translateY(-50%)" }} className="flex flex-col items-center gap-0.5">
      {/* Speech bubbles stack upwards from just above the head; always mounted (empty when none). */}
      <div className="flex flex-col-reverse items-center gap-1" style={{ marginBottom: bubbles.length ? bubbleLift : 0 }}>
        {bubbles.map((b, n) => (
          <SpeechBubble key={b.id} b={b} faded={n > 0} />
        ))}
      </div>
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

/** A comic speech bubble: the tag line, a gist, and a tail leaning towards the recipient. */
function SpeechBubble({ b, faded }: { b: Bubble; faded: boolean }) {
  const tailLeft = b.side === "left" ? "18%" : b.side === "right" ? "82%" : "50%";
  const skew = b.side === "left" ? 30 : b.side === "right" ? -30 : 0;
  return (
    <div
      className="relative max-w-48 rounded-2xl px-2.5 py-1 text-[10px] leading-tight shadow-md"
      style={{
        background: "#ffffff",
        color: "#111827",
        border: `2px solid ${b.color}`,
        opacity: b.opacity * (faded ? 0.75 : 1),
        // Snapshots come ~4×/s; the transition smooths the fade between them.
        transition: "opacity 250ms linear",
      }}
    >
      <div className="truncate font-bold whitespace-nowrap">{b.head}</div>
      {b.gist && <div className="line-clamp-2 text-[9px] text-slate-600">{b.gist}</div>}
      <span
        aria-hidden
        className="absolute -bottom-[7px] block size-3 bg-white"
        style={{
          left: tailLeft,
          transform: `translateX(-50%) skewX(${skew}deg) rotate(45deg)`,
          borderRight: `2px solid ${b.color}`,
          borderBottom: `2px solid ${b.color}`,
        }}
      />
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
