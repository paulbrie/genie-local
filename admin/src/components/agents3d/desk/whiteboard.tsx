"use client";

import { type ThreeEvent, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import type { Snapshot, TLTask } from "@/lib/agents3d-timeline";

import { useStableHandler, useWantFrame } from "../frame-governor";
import type { Selection } from "../scene";
import { ServerGauges } from "./gauges";
import { BOARD, TABLE } from "./world";

/**
 * The whiteboard behind the desk: the tasks as post-its in To do / Doing /
 * Done, from the snapshot (so live, and replayed with the scrubber). Every
 * post-it is yellow, with a dot in its owner's (the worker's) colour; when its
 * task changes column it flies there. Done keeps the newest few; cancelled ones are struck through.
 */

type Column = 0 | 1 | 2;
const COLUMNS = ["To do", "Doing", "Done"];
const DONE_KEEP = 8;
const PER_COLUMN = 9;
const NOTE = 2.8;
const FLY_MS = 900;
/** The paper of every post-it: classic sticky-note yellow (dark text reads at 13:1 on it). */
const PAPER = "#fff59d";
/** The owner's colour cue: a dot in the top-right corner, this radius (px of the 256 px note, ~6% of its width). */
const DOT_R = 15;

type Task = Snapshot["tasks"][number];
type Placed = { task: Task; col: Column; x: number; y: number; tilt: number };

const HEADER_H = 2.2;
const colW = BOARD.w / 3;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const columnOf = (t: Task): Column | null =>
  t.state === "dispatched" ? 0 : t.state === "in_progress" || t.state === "blocked" ? 1 : t.state === "done" || t.state === "cancelled" ? 2 : null;

/** Which post-its show, and where (board-local, centre at 0,0). */
export function placeNotes(tasks: Task[]): { placed: Placed[]; more: [number, number, number] } {
  const cols: Task[][] = [[], [], []];
  for (const t of tasks) {
    if (t.guessed) continue;
    const c = columnOf(t);
    if (c !== null) cols[c].push(t);
  }
  // Oldest first in To do and Doing (the queue); newest first in Done.
  cols[0].sort((a, b) => a.since - b.since);
  cols[1].sort((a, b) => a.since - b.since);
  cols[2].sort((a, b) => b.since - a.since);
  const placed: Placed[] = [];
  const more: [number, number, number] = [0, 0, 0];
  cols.forEach((list, c) => {
    const keep = c === 2 ? Math.min(DONE_KEEP, PER_COLUMN) : PER_COLUMN;
    more[c] = Math.max(0, list.length - keep);
    list.slice(0, keep).forEach((task, i) => {
      const row = Math.floor(i / 3);
      const k = i % 3;
      const x0 = -BOARD.w / 2 + c * colW + colW / 2;
      placed.push({
        task,
        col: c as Column,
        x: x0 + (k - 1) * (NOTE + 0.25),
        y: BOARD.h / 2 - HEADER_H - 0.4 - NOTE / 2 - row * (NOTE + 0.45),
        tilt: ((hash(task.key) % 100) / 100 - 0.5) * 0.14,
      });
    });
  });
  return { placed, more };
}

function wrap(g: CanvasRenderingContext2D, text: string, width: number, lines: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (g.measureText(next).width <= width) cur = next;
    else {
      if (cur) out.push(cur);
      cur = w;
      if (out.length === lines) break;
    }
  }
  if (out.length < lines && cur) out.push(cur);
  if (out.length > lines || (out.length === lines && words.join(" ").length > out.join(" ").length)) {
    out.length = lines;
    let last = out[lines - 1];
    while (last && g.measureText(`${last}…`).width > width) last = last.slice(0, -1);
    out[lines - 1] = `${last}…`;
  }
  return out;
}

/** The post-it text: the task's title without lead-in notes like "(after T33)" or a trailing colon. */
export function noteTitle(title: string): string {
  let t = title.replace(/\s+/g, " ").trim();
  while (/^\([^)]*\)\s*/.test(t)) t = t.replace(/^\([^)]*\)\s*/, "");
  t = t.replace(/[\s:]+$/, "");
  return t || title.trim();
}

type Elapsed = { text: string; color: string };

function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h >= 48) return `${Math.floor(h / 24)} d ${h % 24} h`;
  return `${h} h ${String(min % 60).padStart(2, "0")}`;
}

/**
 * The time on a post-it at t: in Doing, how long since it started (its ACK, else
 * the TASK), amber after 1 h and red after 3 h; in Done, how long it took.
 */
export function elapsedFor(task: Task, events: TLTask["events"] | undefined, t: number): Elapsed | null {
  if (!events) return null;
  const upTo = events.filter((e) => e.ms <= t);
  const dispatched = upTo.find((e) => e.state === "dispatched")?.ms;
  const acked = upTo.find((e) => e.state === "in_progress" || e.state === "blocked")?.ms;
  if (task.state === "in_progress" || task.state === "blocked") {
    const start = acked ?? dispatched;
    if (start === undefined) return null;
    const ms = t - start;
    return { text: duration(ms), color: ms > 3 * 3_600_000 ? "#b91c1c" : ms > 3_600_000 ? "#b45309" : "#475569" };
  }
  if (task.state === "done") {
    const start = dispatched ?? acked;
    const done = [...upTo].reverse().find((e) => e.state === "done")?.ms;
    if (start === undefined || done === undefined) return null;
    return { text: `took ${duration(done - start)}`, color: "#475569" };
  }
  return null;
}

function noteTexture(task: Task, color: string, elapsed: Elapsed | null): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = PAPER;
  g.fillRect(0, 0, 256, 256);
  // The owner's dot, ringed so a yellowish agent colour still shows on the paper.
  g.beginPath();
  g.arc(256 - 14 - DOT_R, 14 + DOT_R, DOT_R, 0, Math.PI * 2);
  g.fillStyle = color;
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = "rgba(31, 41, 55, 0.45)";
  g.stroke();
  g.fillStyle = "#1f2937";
  g.font = "bold 40px ui-sans-serif, system-ui, sans-serif";
  g.fillText(task.id ?? "task", 16, 70);
  // Up to four lines of title, ellipsised after that; the elapsed time keeps the bottom line.
  g.font = "23px ui-sans-serif, system-ui, sans-serif";
  wrap(g, noteTitle(task.title), 228, 4).forEach((l, i) => g.fillText(l, 16, 104 + i * 28));
  if (elapsed) {
    g.fillStyle = elapsed.color;
    g.font = "bold 22px ui-sans-serif, system-ui, sans-serif";
    g.textAlign = "right";
    g.fillText(elapsed.text, 242, 240);
    g.textAlign = "left";
  }
  if (task.state === "blocked") {
    g.fillStyle = "#b91c1c";
    g.font = "bold 22px ui-sans-serif, system-ui, sans-serif";
    g.fillText("BLOCKED", 16, 240);
  }
  if (task.state === "cancelled") {
    g.strokeStyle = "#374151";
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(10, 70);
    g.lineTo(246, 160);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function boardTexture(more: [number, number, number]): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1536;
  c.height = 768;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f8fafc";
  g.fillRect(0, 0, c.width, c.height);
  const cw = c.width / 3;
  const hh = (HEADER_H / BOARD.h) * c.height;
  g.strokeStyle = "#94a3b8";
  g.lineWidth = 5;
  g.lineCap = "round";
  for (let i = 1; i < 3; i++) {
    g.beginPath();
    g.moveTo(i * cw, 24);
    g.lineTo(i * cw + 4, c.height - 24);
    g.stroke();
  }
  g.beginPath();
  g.moveTo(24, hh);
  g.lineTo(c.width - 24, hh - 3);
  g.stroke();
  g.font = "bold 72px 'Comic Sans MS', 'Marker Felt', ui-rounded, sans-serif";
  g.textAlign = "center";
  const ink = ["#2563eb", "#c2410c", "#16a34a"]; // equal weight: amber washes out on white
  COLUMNS.forEach((name, i) => {
    g.fillStyle = ink[i];
    g.fillText(name, i * cw + cw / 2, hh - 30);
    if (more[i]) {
      g.font = "40px ui-sans-serif, system-ui, sans-serif";
      g.fillStyle = "#64748b";
      g.fillText(`+${more[i]} more`, i * cw + cw / 2, c.height - 28);
      g.font = "bold 72px 'Comic Sans MS', 'Marker Felt', ui-rounded, sans-serif";
    }
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

const noteGeo = new THREE.PlaneGeometry(NOTE, NOTE);

function PostIt({
  p,
  color,
  elapsed,
  reduced,
  onSelect,
}: {
  p: Placed;
  color: string;
  elapsed: Elapsed | null;
  reduced: boolean;
  onSelect: (s: Selection) => void;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const flight = useRef<{ from: THREE.Vector3; to: THREE.Vector3; t0: number } | null>(null);
  const want = useWantFrame();
  const onClick = useStableHandler((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect({ kind: "task", key: p.task.key });
  });
  // Redrawn when the elapsed text changes (about once a minute live; faster in replay).
  const eText = elapsed?.text ?? "";
  const eColor = elapsed?.color ?? "";
  const tex = useMemo(() => noteTexture(p.task, color, eText ? { text: eText, color: eColor } : null), [p.task, color, eText, eColor]);
  useEffect(() => () => tex.dispose(), [tex]);

  // A new target: fly there (in an arc out from the board), or jump under reduced motion.
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const to = new THREE.Vector3(p.x, p.y, 0.05);
    if (reduced || m.position.lengthSq() === 0) {
      m.position.copy(to);
      flight.current = null;
    } else if (m.position.distanceToSquared(to) > 1e-4) flight.current = { from: m.position.clone(), to, t0: performance.now() };
    want(60);
  }, [p.x, p.y, reduced, want]);

  useFrame(() => {
    const m = ref.current;
    const f = flight.current;
    if (!m || !f) return;
    const k = Math.min(1, (performance.now() - f.t0) / FLY_MS);
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    m.position.lerpVectors(f.from, f.to, e);
    m.position.z = 0.05 + Math.sin(Math.PI * k) * 1.6;
    m.rotation.z = p.tilt + Math.sin(Math.PI * k) * 0.5;
    if (k >= 1) {
      m.rotation.z = p.tilt;
      flight.current = null;
    } else want(60);
  });

  return (
    <mesh
      ref={ref}
      geometry={noteGeo}
      rotation-z={p.tilt}
      castShadow
      onClick={onClick}
    >
      <meshStandardMaterial map={tex} roughness={0.9} />
    </mesh>
  );
}

export function Whiteboard({
  snap,
  tasks,
  colorOf,
  reduced,
  onSelect,
  onBoardClick,
  onColumnClick,
}: {
  snap: Snapshot;
  /** The timeline's tasks, for their start/done times. */
  tasks: TLTask[];
  colorOf: (key: string) => string;
  reduced: boolean;
  onSelect: (s: Selection) => void;
  onBoardClick: () => void;
  /** A column heading was clicked (0 To do, 1 Doing, 2 Done). */
  onColumnClick: (col: number) => void;
}) {
  const events = useMemo(() => new Map(tasks.map((t) => [t.key, t.events])), [tasks]);
  // A heading flies to its column; anywhere else on the board, to the whole board.
  const onBoard = useStableHandler((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const uv = e.uv;
    if (uv && uv.y > 1 - HEADER_H / BOARD.h) onColumnClick(Math.min(2, Math.floor(uv.x * 3)));
    else onBoardClick();
  });
  // Recomputed only when a task's column or text changes, not on every snapshot.
  const sig = snap.tasks.map((t) => `${t.key}:${t.state}:${t.since}`).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { placed, more } = useMemo(() => placeNotes(snap.tasks), [sig]);
  const boardTex = useMemo(() => boardTexture(more), [more]);
  useEffect(() => () => boardTex.dispose(), [boardTex]);
  const frameGeo = useMemo(() => new RoundedBoxGeometry(BOARD.w + 0.8, BOARD.h + 0.8, 0.4, 3, 0.15), []);
  const floor = -TABLE.h;

  return (
    <group position={[BOARD.x, BOARD.y + BOARD.h / 2, BOARD.z]}>
      {/* the stand */}
      {[-1, 1].map((sx) => (
        <mesh key={sx} position={[sx * (BOARD.w / 2 - 1), (floor - BOARD.y - BOARD.h / 2 + BOARD.h / 2) / 2, -0.3]} castShadow>
          <cylinderGeometry args={[0.18, 0.18, BOARD.y + BOARD.h / 2 - floor, 12]} />
          <meshStandardMaterial color="#94a3b8" metalness={0.6} roughness={0.3} />
        </mesh>
      ))}
      <mesh geometry={frameGeo} position={[0, 0, -0.25]} castShadow receiveShadow>
        <meshStandardMaterial color="#cbd5e1" metalness={0.5} roughness={0.35} />
      </mesh>
      <mesh
        position={[0, 0, -0.03]}
        receiveShadow
        onClick={onBoard}
      >
        <planeGeometry args={[BOARD.w, BOARD.h]} />
        {/* Matte, so the lamp and the room don't wash out the headings up close. */}
        <meshStandardMaterial map={boardTex} roughness={0.85} />
      </mesh>
      <ServerGauges />
      {placed.map((p) => (
        <PostIt
          key={p.task.key}
          p={p}
          color={colorOf(p.task.worker)}
          elapsed={elapsedFor(p.task, events.get(p.task.key), snap.t)}
          reduced={reduced}
          onSelect={onSelect}
        />
      ))}
    </group>
  );
}
