"use client";

import { type ThreeEvent, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import type { TLCommit } from "@/lib/agents3d-timeline";

import { useStableHandler, useWantFrame } from "../frame-governor";
import { OverlayLabel } from "../overlay-label";
import type { Selection } from "../scene";
import { boardTop, bookSpots, SHELF_BOOKS } from "./shelf";
import type { ShelfRun } from "./walk";
import { FLOOR_Y, type Seat, SHELF } from "./world";

const woodMat = new THREE.MeshStandardMaterial({ color: "#8a5f3a", roughness: 0.7 });
const backMat = new THREE.MeshStandardMaterial({ color: "#6b4a2e", roughness: 0.85 });
const bookGeo = new RoundedBoxGeometry(1, 1, 1, 1, 0.04);

/**
 * The commits as books on a bookshelf left of the whiteboard (T95): a spine in
 * the committer's colour, the newest at the end of the top shelf (shelf.ts),
 * the full name on hover; instanced, written only when the books change. Live,
 * a new commit's book appears when Alice has walked it over (walk.ts; this
 * frame drives that run, before the agents read it), or settles in at once if
 * nobody is there to walk. In replay the books are as of the scrubber's time.
 */
export function Bookshelf({
  commits,
  live,
  walker,
  run,
  colorOf,
  onSelect,
}: {
  commits: TLCommit[];
  live: boolean;
  /** Who shelves the books (Alice's seat), or null. */
  walker: Seat | null;
  run: ShelfRun;
  colorOf: (node: string) => string;
  onSelect: (s: Selection) => void;
}) {
  const books = useRef<THREE.InstancedMesh>(null);
  const want = useWantFrame();
  const hashes = useMemo(() => commits.map((c) => c.hash), [commits]);
  const byHash = useMemo(() => new Map(commits.map((c) => [c.hash, c])), [commits]);
  // What's on the shelf as last written: its key, and which commit each instance shows.
  const written = useRef<{ key: string; order: string[]; settling: boolean }>({ key: "", order: [], settling: false });
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), c: new THREE.Color() }), []);

  useFrame(() => {
    const now = performance.now();
    run.update(hashes, now, live, walker);
    const m = books.current;
    if (!m) return;
    const hidden = run.hidden(now);
    const shown = hidden.size ? hashes.filter((h) => !hidden.has(h)) : hashes;
    const settling = run.settling.size > 0;
    const key = `${shown.length}|${shown[shown.length - 1] ?? ""}`;
    const w = written.current;
    // Rewritten when the books change, and every frame while one settles (plus once more, at rest).
    if (key !== w.key || settling || w.settling) {
      w.key = key;
      w.settling = settling;
      w.order.length = 0;
      let n = 0;
      for (const [hash, s] of bookSpots(shown)) {
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
  const spot = hovered ? bookSpots(hashes).get(hovered.hash) : undefined;

  // The frame: a back, two sides, the boards.
  const frame = useMemo(() => {
    const parts: { pos: [number, number, number]; size: [number, number, number]; back?: boolean }[] = [];
    const cy = FLOOR_Y + SHELF.h / 2;
    parts.push({ pos: [SHELF.x, cy, SHELF.z - SHELF.d / 2 + 0.05], size: [SHELF.w, SHELF.h, 0.1], back: true });
    for (const sx of [-1, 1]) parts.push({ pos: [SHELF.x + sx * (SHELF.w / 2 - SHELF.side / 2), cy, SHELF.z], size: [SHELF.side, SHELF.h, SHELF.d] });
    for (let n = 0; n <= SHELF.shelves; n++) {
      const top = n < SHELF.shelves ? boardTop(n) : FLOOR_Y + SHELF.h;
      parts.push({ pos: [SHELF.x, top - SHELF.board / 2, SHELF.z], size: [SHELF.w - 2 * SHELF.side, SHELF.board, SHELF.d] });
    }
    return parts.map((p) => ({ ...p, geo: new THREE.BoxGeometry(...p.size) }));
  }, []);
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
