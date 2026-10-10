"use client";

import { type ThreeEvent, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import type { TLCommit } from "@/lib/agents3d-timeline";

import { useStableHandler, useWantFrame } from "../frame-governor";
import { OverlayLabel } from "../overlay-label";
import type { Selection } from "../scene";
import { boardTop, bookSpots, SHELF_BOOKS, shelfHeight, type ShelfRow } from "./shelf";
import type { ShelfRun } from "./walk";
import { FLOOR_Y, PERSON_H, type Seat, SHELF } from "./world";

const woodMat = new THREE.MeshStandardMaterial({ color: "#8a5f3a", roughness: 0.7 });
const backMat = new THREE.MeshStandardMaterial({ color: "#6b4a2e", roughness: 0.85 });
const bookGeo = new RoundedBoxGeometry(1, 1, 1, 1, 0.04);
const PLATE_STYLE = { pointerEvents: "none" } as const;

/**
 * The commits as books on a bookshelf left of the whiteboard (T95, T133): a
 * shelf per project on the table, in the table's order, its name on a plate;
 * each book's spine in the committer's colour, the newest at the right end of
 * its project's shelf (shelf.ts), the full name on hover; instanced, written
 * only when the books change. The bookcase grows with the shelves. Live,
 * a new commit's book appears when Alice has walked it over (walk.ts; this
 * frame drives that run, before the agents read it), or settles in at once if
 * nobody is there to walk. In replay the books are as of the scrubber's time.
 */
export function Bookshelf({
  commits,
  rows,
  live,
  walker,
  run,
  colorOf,
  onSelect,
}: {
  commits: TLCommit[];
  /** The shelves: a project each (shelfRows, in the table's order). */
  rows: ShelfRow[];
  live: boolean;
  /** Who shelves the books (Alice's seat), or null. */
  walker: Seat | null;
  run: ShelfRun;
  colorOf: (node: string) => string;
  onSelect: (s: Selection) => void;
}) {
  const books = useRef<THREE.InstancedMesh>(null);
  const want = useWantFrame();
  // Only commits with a shelf (their project on the table) are books, and walked over.
  const shelved = useMemo(() => {
    const repos = new Set(rows.flatMap((r) => r.repos));
    return commits.filter((c) => c.repo !== null && repos.has(c.repo));
  }, [commits, rows]);
  const hashes = useMemo(() => shelved.map((c) => c.hash), [shelved]);
  const byHash = useMemo(() => new Map(shelved.map((c) => [c.hash, c])), [shelved]);
  // Where every book goes once shelved: for hovering, and how high Alice reaches with it.
  const allSpots = useMemo(() => bookSpots(rows, shelved), [rows, shelved]);
  const reachOf = useMemo(
    () => (hash: string) => {
      const s = allSpots.get(hash);
      return s ? Math.max(0, Math.min(1, (s.y - FLOOR_Y) / (PERSON_H * 1.15))) : 0.5;
    },
    [allSpots],
  );
  // What's on the shelf as last written: its key, and which commit each instance shows.
  const written = useRef<{ key: string; order: string[]; settling: boolean }>({ key: "", order: [], settling: false });
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), c: new THREE.Color() }), []);

  useFrame(() => {
    const now = performance.now();
    run.update(hashes, now, live, walker, reachOf);
    const m = books.current;
    if (!m) return;
    const hidden = run.hidden(now);
    const shown = hidden.size ? shelved.filter((c) => !hidden.has(c.hash)) : shelved;
    const settling = run.settling.size > 0;
    const key = `${rows.map((r) => r.key).join(",")}|${shown.length}|${shown[shown.length - 1]?.hash ?? ""}`;
    const w = written.current;
    // Rewritten when the books change, and every frame while one settles (plus once more, at rest).
    if (key !== w.key || settling || w.settling) {
      w.key = key;
      w.settling = settling;
      w.order.length = 0;
      let n = 0;
      for (const [hash, s] of bookSpots(rows, shown)) {
        tmp.m.makeScale(s.w, s.h, s.d).setPosition(s.x, s.y + run.settle(hash, now), s.z);
        m.setMatrixAt(n, tmp.m);
        m.setColorAt(n, tmp.c.set(colorOf(byHash.get(hash)?.node ?? "")));
        w.order[n++] = hash;
      }
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
    }
    if (run.busy(now)) want(30);
  });

  const [hover, setHover] = useState<string | null>(null);
  const onMove = useStableHandler((e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHover(e.instanceId === undefined ? null : (written.current.order[e.instanceId] ?? null));
  });
  const onOut = useStableHandler(() => setHover(null));
  const onClick = useStableHandler((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const hash = e.instanceId === undefined ? undefined : written.current.order[e.instanceId];
    if (hash) onSelect({ kind: "commit", hash });
  });
  const hovered = hover ? byHash.get(hover) : undefined;
  const spot = hovered ? allSpots.get(hovered.hash) : undefined;

  // The frame: a back, two sides, the boards; as tall as its shelves.
  const n = Math.max(1, rows.length);
  const frame = useMemo(() => {
    const h = shelfHeight(n);
    const parts: { pos: [number, number, number]; size: [number, number, number]; back?: boolean }[] = [];
    const cy = FLOOR_Y + h / 2;
    parts.push({ pos: [SHELF.x, cy, SHELF.z - SHELF.d / 2 + 0.05], size: [SHELF.w, h, 0.1], back: true });
    for (const sx of [-1, 1]) parts.push({ pos: [SHELF.x + sx * (SHELF.w / 2 - SHELF.side / 2), cy, SHELF.z], size: [SHELF.side, h, SHELF.d] });
    for (let i = 0; i <= n; i++) {
      const top = i < n ? boardTop(i, n) : FLOOR_Y + h;
      parts.push({ pos: [SHELF.x, top - SHELF.board / 2, SHELF.z], size: [SHELF.w - 2 * SHELF.side, SHELF.board, SHELF.d] });
    }
    return parts.map((p) => ({ ...p, geo: new THREE.BoxGeometry(...p.size) }));
  }, [n]);
  useEffect(() => () => frame.forEach((p) => p.geo.dispose()), [frame]);

  return (
    <group>
      {frame.map((p, i) => (
        <mesh key={i} geometry={p.geo} material={p.back ? backMat : woodMat} position={p.pos} castShadow receiveShadow />
      ))}
      <instancedMesh
        ref={books}
        args={[bookGeo, undefined, SHELF_BOOKS]}
        count={0}
        castShadow
        onPointerMove={onMove}
        onPointerOut={onOut}
        onClick={onClick}
      >
        <meshStandardMaterial roughness={0.6} />
      </instancedMesh>
      {/* each shelf's project, on a plate at its board's front edge */}
      {rows.map((r, i) => (
        <OverlayLabel
          key={r.key}
          position={[SHELF.x - SHELF.w / 2 + SHELF.side + 0.2, boardTop(i, n) - SHELF.board / 2, SHELF.z + SHELF.d / 2 + 0.05]}
          zIndexRange={[12, 0]}
          style={PLATE_STYLE}
        >
          <div className="-translate-y-1/2 whitespace-nowrap rounded-sm border border-amber-200/40 bg-amber-950/80 px-1 text-[9px] leading-[13px] text-amber-50">{r.name}</div>
        </OverlayLabel>
      ))}
      {hovered && spot && (
        <OverlayLabel position={[spot.x, spot.y + spot.h / 2 + 0.3, spot.z + spot.d / 2]} center zIndexRange={[30, 0]} style={{ pointerEvents: "none" }}>
          <div className="max-w-[18em] truncate whitespace-nowrap rounded bg-black/75 px-1.5 py-0.5 text-[10px] text-white/90">
            <span className="font-mono">{hovered.abbrev}</span>
            {hovered.repo ? <span className="text-white/60"> · {hovered.repo}</span> : null}
            {hovered.subject ? <span> · {hovered.subject}</span> : null}
          </div>
        </OverlayLabel>
      )}
    </group>
  );
}
