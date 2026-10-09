"use client";

import { type ThreeEvent, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import type { Snapshot } from "@/lib/agents3d-timeline";

import type { Selection } from "../scene";
import { BOARD, TABLE } from "./world";

/**
 * The whiteboard behind the desk: the tasks as post-its in To do / Doing /
 * Done, from the snapshot (so live, and replayed with the scrubber). A post-it
 * is coloured by its owner (the worker); when its task changes column it
 * flies there. Done keeps the newest few; cancelled ones are struck through.
 */

type Column = 0 | 1 | 2;
const COLUMNS = ["To do", "Doing", "Done"];
const DONE_KEEP = 8;
const PER_COLUMN = 9;
const NOTE = 2.8;
const FLY_MS = 900;

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

function noteTexture(task: Task, color: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const paper = new THREE.Color(color).lerp(new THREE.Color("#ffffff"), 0.62);
  g.fillStyle = `#${paper.getHexString()}`;
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = color;
  g.fillRect(0, 0, 256, 26);
  g.fillStyle = "#1f2937";
  g.font = "bold 46px ui-sans-serif, system-ui, sans-serif";
  g.fillText(task.id ?? "task", 16, 82);
  g.font = "28px ui-sans-serif, system-ui, sans-serif";
  wrap(g, noteTitle(task.title), 224, 2).forEach((l, i) => g.fillText(l, 16, 132 + i * 36));
  if (task.state === "blocked") {
    g.fillStyle = "#ef4444";
    g.font = "bold 26px ui-sans-serif, system-ui, sans-serif";
    g.fillText("BLOCKED", 16, 236);
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

function PostIt({ p, color, reduced, onSelect }: { p: Placed; color: string; reduced: boolean; onSelect: (s: Selection) => void }) {
  const ref = useRef<THREE.Mesh>(null);
  const flight = useRef<{ from: THREE.Vector3; to: THREE.Vector3; t0: number } | null>(null);
  const tex = useMemo(() => noteTexture(p.task, color), [p.task, color]);
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
  }, [p.x, p.y, reduced]);

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
    }
  });

  return (
    <mesh
      ref={ref}
      geometry={noteGeo}
      rotation-z={p.tilt}
      castShadow
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        onSelect({ kind: "task", key: p.task.key });
      }}
    >
      <meshStandardMaterial map={tex} roughness={0.9} />
    </mesh>
  );
}

export function Whiteboard({
  snap,
  colorOf,
  reduced,
  onSelect,
  onBoardClick,
}: {
  snap: Snapshot;
  colorOf: (key: string) => string;
  reduced: boolean;
  onSelect: (s: Selection) => void;
  onBoardClick: () => void;
}) {
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
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onBoardClick();
        }}
      >
        <planeGeometry args={[BOARD.w, BOARD.h]} />
        <meshStandardMaterial map={boardTex} roughness={0.35} />
      </mesh>
      {placed.map((p) => (
        <PostIt key={p.task.key} p={p} color={colorOf(p.task.worker)} reduced={reduced} onSelect={onSelect} />
      ))}
    </group>
  );
}
