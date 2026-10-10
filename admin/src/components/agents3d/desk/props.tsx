"use client";

import { type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import { fileKey, type Snapshot, type Timeline, type TLCommit } from "@/lib/agents3d-timeline";
import type { CityLayout } from "@/lib/city-layout";

import type { Clock } from "../clock";
import { useStableHandler, useWantFrame } from "../frame-governor";
import { OverlayLabel } from "../overlay-label";
import { realAge } from "../parts";
import type { Selection } from "../scene";
import { DistrictLabels } from "./district-labels";
import { BEACON, LAMP, type MiniCities, MUG, PAPERS, PLATE_H, TABLE, TOWER } from "./world";

const stop = (e: ThreeEvent<MouseEvent>) => e.stopPropagation();
/** The lamp's bulb: bright enough to bloom. */
const BULB = new THREE.Color("#fff1c9").multiplyScalar(2.5);

/** A rounded box geometry, built once per size. */
const rounded = new Map<string, RoundedBoxGeometry>();
function rbox(w: number, h: number, d: number, seg = 3, r = 0.05) {
  const k = `${w}|${h}|${d}|${seg}|${r}`;
  let g = rounded.get(k);
  if (!g) rounded.set(k, (g = new RoundedBoxGeometry(w, h, d, seg, r)));
  return g;
}

function Clay({ color, ...rest }: { color: string } & Partial<THREE.MeshPhysicalMaterialParameters>) {
  return <meshPhysicalMaterial color={color} roughness={0.58} clearcoat={0.12} clearcoatRoughness={0.5} {...rest} />;
}

/** The round tabletop on one pedestal, over a floor. */
export function DeskTop() {
  const geo = useMemo(() => new THREE.CylinderGeometry(TABLE.r, TABLE.r, 0.6, 96), []);
  const grain = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 256;
    const g = c.getContext("2d")!;
    g.fillStyle = "#c08d5c";
    g.fillRect(0, 0, 512, 256);
    for (let i = 0; i < 90; i++) {
      g.strokeStyle = `rgba(${90 + (i % 5) * 8},${55 + (i % 3) * 6},30,${0.06 + (i % 4) * 0.025})`;
      g.lineWidth = 1 + (i % 3);
      g.beginPath();
      const y = (i * 37) % 256;
      g.moveTo(0, y);
      for (let x = 0; x <= 512; x += 32) g.lineTo(x, y + Math.sin(x / 60 + i) * 4);
      g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1.5, 1.5);
    return t;
  }, []);
  return (
    <group>
      <mesh geometry={geo} position={[0, -0.3, 0]} receiveShadow>
        <meshPhysicalMaterial map={grain} roughness={0.55} clearcoat={0.3} clearcoatRoughness={0.4} />
      </mesh>
      {/* the floor far below, so the desk doesn't float in a void */}
      <mesh rotation-x={-Math.PI / 2} position={[0, -TABLE.h, 0]} receiveShadow>
        <circleGeometry args={[60, 48]} />
        <meshStandardMaterial color="#2a2522" roughness={1} />
      </mesh>
      {/* the pedestal: a column and a round foot */}
      <mesh position={[0, -TABLE.h / 2 - 0.3, 0]} castShadow>
        <cylinderGeometry args={[1.1, 1.4, TABLE.h - 0.6, 32]} />
        <Clay color="#8a5f3a" />
      </mesh>
      <mesh position={[0, -TABLE.h + 0.25, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[4.2, 4.6, 0.5, 48]} />
        <Clay color="#7a5232" />
      </mesh>
    </group>
  );
}

/** A stack of papers and a pencil: the reading nook. */
export function Papers() {
  return (
    <group position={[PAPERS.x, 0, PAPERS.z]} scale={1.3}>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} position={[i * 0.04, 0.012 + i * 0.022, -i * 0.03]} rotation-y={0.25 - i * 0.11} receiveShadow castShadow>
          <boxGeometry args={[2.1, 0.02, 2.8]} />
          <meshStandardMaterial color={i === 3 ? "#fffdf7" : "#f1eee6"} roughness={0.9} />
        </mesh>
      ))}
      {[0, 1, 2, 3, 4, 5].map((l) => (
        <mesh key={l} position={[-0.1 + (l % 2) * 0.08, 0.1, -0.9 + l * 0.32]} rotation-y={-0.08}>
          <boxGeometry args={[l % 3 === 2 ? 1.0 : 1.5, 0.004, 0.05]} />
          <meshBasicMaterial color="#94a3b8" />
        </mesh>
      ))}
      <mesh position={[1.4, 0.06, 0.6]} rotation={[0, 0.6, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.06, 0.06, 1.6, 6]} />
        <Clay color="#facc15" />
      </mesh>
    </group>
  );
}

export function Mug({ reduced }: { reduced: boolean }) {
  const steam = useRef<(THREE.Mesh | null)[]>([]);
  // The steam asks for no frames of its own: it drifts only while the table is drawn anyway.
  useFrame(({ clock }) => {
    steam.current.forEach((m, i) => {
      if (!m) return;
      const k = (clock.elapsedTime * 0.35 + i / 3) % 1;
      m.position.set(Math.sin(k * 6 + i) * 0.12, 1.3 + k * 1.3, 0);
      m.scale.setScalar(0.12 + k * 0.18);
      (m.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.35;
    });
  });
  return (
    <group position={[MUG.x, 0, MUG.z]} scale={1.3}>
      <mesh position={[0, 0.6, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.55, 0.5, 1.2, 40]} />
        <Clay color="#f97316" />
      </mesh>
      <mesh position={[0.58, 0.62, 0]} castShadow>
        <torusGeometry args={[0.28, 0.08, 12, 24]} />
        <Clay color="#f97316" />
      </mesh>
      <mesh position={[0, 1.17, 0]}>
        <cylinderGeometry args={[0.48, 0.48, 0.02, 40]} />
        <meshStandardMaterial color="#3b2414" roughness={0.2} />
      </mesh>
      {!reduced &&
        [0, 1, 2].map((i) => (
          <mesh
            key={i}
            ref={(m) => {
              steam.current[i] = m;
            }}
          >
            <sphereGeometry args={[1, 12, 8]} />
            <meshBasicMaterial color="#ffffff" transparent depthWrite={false} />
          </mesh>
        ))}
    </group>
  );
}

export function Lamp() {
  return (
    <group position={[LAMP.x, 0, LAMP.z]} scale={1.5}>
      <mesh position={[0, 0.1, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.8, 0.9, 0.2, 32]} />
        <Clay color="#1e3a5f" />
      </mesh>
      <mesh position={[0.25, 1.9, 0.2]} rotation={[0.15, 0, -0.2]} castShadow>
        <cylinderGeometry args={[0.07, 0.07, 3.6, 12]} />
        <Clay color="#1e3a5f" />
      </mesh>
      <group position={[0.75, 3.75, 0.55]} rotation={[0.45, 0, -0.75]}>
        <mesh castShadow>
          <coneGeometry args={[0.8, 0.9, 32, 1, true]} />
          <Clay color="#1e3a5f" side={THREE.DoubleSide} />
        </mesh>
        <mesh position={[0, -0.25, 0]}>
          <sphereGeometry args={[0.25, 16, 12]} />
          <meshBasicMaterial color={BULB} toneMapped={false} />
        </mesh>
      </group>
      <pointLight position={[1.6, 3.0, 1.4]} color="#ffcf8a" intensity={9} distance={16} decay={1.6} />
    </group>
  );
}

const BLOCK = { w: 0.75, h: 0.18 };
/** Newest commits shown as blocks; the label counts them all. */
const TOWER_MAX = 16;

/** Commits as clay blocks in the committer's colour, the newest dropping in. */
export function CommitTower({
  commits,
  clock,
  colorOf,
  reduced,
  onSelect,
}: {
  commits: TLCommit[];
  clock: Clock;
  colorOf: (node: string) => string;
  reduced: boolean;
  onSelect: (s: Selection) => void;
}) {
  const shown = commits.slice(-TOWER_MAX);
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  const geo = useMemo(() => new RoundedBoxGeometry(BLOCK.w, BLOCK.h, BLOCK.w, 2, 0.05), []);
  const want = useWantFrame();
  // One handler for every block (named by its hash), so re-renders don't redraw.
  const pick = useStableHandler((e: ThreeEvent<MouseEvent>) => {
    stop(e);
    onSelect({ kind: "commit", hash: e.eventObject.name });
  });
  useFrame(() => {
    const t = clock.now();
    shown.forEach((c, i) => {
      const m = refs.current[i];
      if (!m) return;
      const age = realAge(clock, t, c.ms);
      const y = 0.2 + i * (BLOCK.h + 0.01) + BLOCK.h / 2;
      const dropping = !reduced && age >= 0 && age <= 1200;
      m.position.y = dropping ? y + (1 - age / 1200) ** 2 * 3 : y;
      if (dropping) want(30);
    });
  });
  return (
    <group position={[TOWER.x, 0, TOWER.z]} scale={1.5}>
      <mesh position={[0, 0.1, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.65, 0.75, 0.2, 32]} />
        <Clay color="#475569" />
      </mesh>
      {shown.map((c, i) => (
        <mesh
          key={c.hash}
          ref={(m) => {
            refs.current[i] = m;
          }}
          geometry={geo}
          position={[0, 0.2 + i * (BLOCK.h + 0.01) + BLOCK.h / 2, 0]}
          rotation-y={(i % 4) * 0.08 - 0.12}
          castShadow
          name={c.hash}
          onClick={pick}
        >
          <Clay color={colorOf(c.node)} />
        </mesh>
      ))}
      <OverlayLabel position={[0, -0.05, 0.85]} center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
        <div className="whitespace-nowrap rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white/80">
          {commits.length} commit{commits.length === 1 ? "" : "s"}
        </div>
      </OverlayLabel>
    </group>
  );
}

/** The "origin" beacon: a little lighthouse whose lamp flashes cyan on a push. */
export function OriginBeacon({ commits, clock, reduced }: { commits: TLCommit[]; clock: Clock; reduced: boolean }) {
  const lamp = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const col = useMemo(() => new THREE.Color(), []);
  const want = useWantFrame();
  useFrame(({ clock: c3 }) => {
    const t = clock.now();
    let flash = 0;
    for (const c of commits) {
      if (c.pushedMs == null) continue;
      const age = realAge(clock, t, c.pushedMs);
      if (age >= 0 && age < 3500) flash = Math.max(flash, 1 - age / 3500);
    }
    const idle = reduced ? 0.4 : 0.35 + Math.sin(c3.elapsedTime * 1.5) * 0.1;
    // A push's flash asks for frames; the idle glow pulses only while the table is drawn anyway.
    if (flash > 0) want(reduced ? 10 : 30);
    if (lamp.current) (lamp.current.material as THREE.MeshBasicMaterial).color.copy(col.set("#06b6d4").multiplyScalar(1 + idle + flash * 3));
    if (halo.current) {
      halo.current.scale.setScalar(1 + flash * 2.5);
      (halo.current.material as THREE.MeshBasicMaterial).opacity = 0.08 + flash * 0.5;
    }
  });
  return (
    <group position={[BEACON.x, 0, BEACON.z]} scale={1.5}>
      <mesh position={[0, 0.9, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.28, 0.5, 1.8, 24]} />
        <Clay color="#f8fafc" />
      </mesh>
      {[0.5, 1.2].map((y) => (
        <mesh key={y} position={[0, y, 0]}>
          <cylinderGeometry args={[0.5 - y * 0.17, 0.52 - y * 0.17, 0.2, 24]} />
          <Clay color="#ef4444" />
        </mesh>
      ))}
      <mesh ref={lamp} position={[0, 2.05, 0]}>
        <sphereGeometry args={[0.3, 20, 16]} />
        <meshBasicMaterial toneMapped={false} />
      </mesh>
      <mesh position={[0, 2.4, 0]} castShadow>
        <coneGeometry args={[0.4, 0.35, 24]} />
        <Clay color="#334155" />
      </mesh>
      <mesh ref={halo} position={[0, 2.05, 0]}>
        <sphereGeometry args={[0.6, 20, 16]} />
        <meshBasicMaterial color="#06b6d4" transparent depthWrite={false} toneMapped={false} />
      </mesh>
      <OverlayLabel position={[0, -0.05, 0.75]} center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
        <div className="whitespace-nowrap rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-cyan-200">origin</div>
      </OverlayLabel>
    </group>
  );
}

// ── Miniature cities ─────────────────────────────────────────────────────────

const EXT: Record<string, string> = {
  ts: "#93c5fd",
  tsx: "#a5b4fc",
  js: "#fde68a",
  jsx: "#fde68a",
  mjs: "#fde68a",
  json: "#bef264",
  md: "#86efac",
  mdx: "#86efac",
  css: "#f0abfc",
  scss: "#f0abfc",
  sql: "#fdba74",
  py: "#67e8f9",
  sh: "#d4d4d8",
};
const DEFAULT_EXT = "#e2e8f0";
const CLASH = "#ef4444";

/**
 * Alex's city layout (read-only, via layoutCities) as clay miniatures on
 * plates. Held files take their holder's colour and fly a flag; files being
 * edited glow in the editor's colour. Pointing at a building names its file;
 * close up, the neighbourhoods are named too.
 */
export function MiniCityView({
  tl,
  snap,
  layout,
  mini,
  colorOf,
  editing,
  reduced,
  onSelect,
}: {
  tl: Timeline;
  snap: Snapshot;
  layout: CityLayout;
  mini: MiniCities;
  colorOf: (node: string) => string;
  /** fileKey → editor colour. */
  editing: Map<string, string>;
  reduced: boolean;
  onSelect: (s: Selection) => void;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  // The building under the pointer (layout index), named in a label.
  const [hover, setHover] = useState<number | null>(null);
  const hovered = hover !== null && hover < layout.buildings.length ? { b: layout.buildings[hover], top: mini.top(hover) } : null;
  const geo = useMemo(() => new RoundedBoxGeometry(1, 1, 1, 1, 0.12), []);
  // The buildings are written in place (not through props): a write that changes something asks for a frame.
  const invalidate = useThree((s) => s.invalidate);
  // The colours last written, per building, for the mesh they were written to.
  const written = useRef<{ m: THREE.InstancedMesh | null; rgb: Float64Array }>({ m: null, rgb: new Float64Array(0) });
  const onClick = useStableHandler((e: ThreeEvent<MouseEvent>) => {
    stop(e);
    if (e.instanceId !== undefined && e.instanceId < layout.buildings.length) onSelect({ kind: "file", key: layout.buildings[e.instanceId].key });
  });
  const onPointerMove = useStableHandler((e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHover(e.instanceId ?? null);
  });
  const onPointerOut = useStableHandler(() => setHover(null));
  const dirty = useMemo(() => {
    const s = new Set<string>();
    for (const r of tl.repos) for (const d of r.dirty) s.add(fileKey(r.id, d.p));
    return s;
  }, [tl]);

  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const mat = new THREE.Matrix4();
    layout.buildings.forEach((b, i) => {
      const top = mini.top(i);
      const h = top.y - PLATE_H;
      mat.makeScale(Math.max(0.03, b.w * mini.s * 0.9), h, Math.max(0.03, b.d * mini.s * 0.9)).setPosition(top.x, PLATE_H + h / 2, top.z);
      m.setMatrixAt(i, mat);
    });
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
    invalidate();
  }, [layout, mini, invalidate]);

  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const c = new THREE.Color();
    const w = written.current;
    if (w.m !== m || w.rgb.length !== layout.buildings.length * 3) {
      w.m = m;
      w.rgb = new Float64Array(layout.buildings.length * 3).fill(-1);
    }
    let changed = false;
    layout.buildings.forEach((b, i) => {
      const h = snap.holders.get(b.key);
      const ed = editing.get(b.key);
      if (ed) c.set(ed).multiplyScalar(1.6);
      else if (h?.length) c.set(h.length > 1 ? CLASH : colorOf(h[0]));
      else c.set(EXT[b.ext] ?? DEFAULT_EXT).multiplyScalar(dirty.has(b.key) ? 1 : 0.85);
      const o = i * 3;
      if (w.rgb[o] === c.r && w.rgb[o + 1] === c.g && w.rgb[o + 2] === c.b) return;
      w.rgb[o] = c.r;
      w.rgb[o + 1] = c.g;
      w.rgb[o + 2] = c.b;
      m.setColorAt(i, c);
      changed = true;
    });
    if (!changed) return;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    invalidate();
  }, [layout, snap, editing, colorOf, dirty, invalidate]);

  const flags = [...snap.holders.entries()].flatMap(([k, holders]) => {
    const i = layout.index.get(k);
    return i === undefined ? [] : [{ k, top: mini.top(i), color: holders.length > 1 ? CLASH : colorOf(holders[0]) }];
  });

  return (
    <group>
      {mini.plates.map((p) => (
        <group key={p.name} position={[p.x, 0, p.z]}>
          <mesh position={[0, PLATE_H / 2, 0]} receiveShadow castShadow>
            <primitive object={rbox(p.w, PLATE_H, p.d, 2, 0.04)} attach="geometry" />
            <meshPhysicalMaterial color="#3f4656" roughness={0.6} clearcoat={0.2} />
          </mesh>
          <OverlayLabel position={[0, 0.05, p.d / 2 + 0.15]} center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
            <div className="whitespace-nowrap rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white/80">{p.name}</div>
          </OverlayLabel>
        </group>
      ))}
      {layout.buildings.length > 0 && (
        <instancedMesh
          key={layout.buildings.length}
          ref={ref}
          args={[geo, undefined, layout.buildings.length]}
          castShadow
          receiveShadow
          onClick={onClick}
          onPointerMove={onPointerMove}
          onPointerOut={onPointerOut}
        >
          <meshPhysicalMaterial roughness={0.55} clearcoat={0.15} />
        </instancedMesh>
      )}
      {hovered && (
        <OverlayLabel position={[hovered.top.x, hovered.top.y + 0.2, hovered.top.z]} center zIndexRange={[40, 30]} style={{ pointerEvents: "none" }}>
          <div className="-translate-y-3 whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-white">{hovered.b.path}</div>
        </OverlayLabel>
      )}
      <DistrictLabels layout={layout} mini={mini} reduced={reduced} />
      {flags.map((f) => (
        <group key={f.k} position={[f.top.x, f.top.y, f.top.z]}>
          <mesh position={[0, 0.25, 0]}>
            <cylinderGeometry args={[0.012, 0.012, 0.5, 6]} />
            <meshStandardMaterial color="#e2e8f0" />
          </mesh>
          <mesh position={[0.11, 0.42, 0]}>
            <boxGeometry args={[0.22, 0.13, 0.01]} />
            <meshStandardMaterial color={f.color} emissive={f.color} emissiveIntensity={0.5} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
