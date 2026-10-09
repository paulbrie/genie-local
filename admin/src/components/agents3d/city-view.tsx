"use client";

import { type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { editor, fileKey, type Snapshot, type Timeline, type TLCommit } from "@/lib/agents3d-timeline";
import type { CityLayout } from "@/lib/city-layout";

import type { Clock } from "./clock";
import { OverlayLabel } from "./overlay-label";
import { Lightning, type Strike, tailFade } from "./lightning";
import type { PaneView } from "./use-panes";
import { AgentLabel, CommitTower, MessageArcs, type Positions, realAge, useSeen } from "./parts";
import type { Selection } from "./scene";

const EXT_COLORS: Record<string, string> = {
  ts: "#5b7bb5",
  tsx: "#6a8fd0",
  js: "#b5a85b",
  jsx: "#c2b562",
  mjs: "#b5a85b",
  json: "#7a8a6a",
  md: "#6aa07a",
  mdx: "#6aa07a",
  css: "#a06aa0",
  scss: "#a06aa0",
  sql: "#a0866a",
  py: "#6a9aa0",
  sh: "#8a8a8a",
  png: "#606070",
  svg: "#707060",
};
const DEFAULT_EXT = "#6b7280";
const AMBER = new THREE.Color("#f59e0b");
const RED = new THREE.Color("#ef4444");
const WHITE = new THREE.Color("#ffffff");
const GREY = new THREE.Color("#94a3b8");

const EDIT_PULSE_MS = 3500;
const BEAMS = 24;

export function CityView({
  tl,
  snap,
  clock,
  layout,
  positions,
  reduced,
  selected,
  onSelect,
  onAgentClick,
  linger,
  panes,
}: {
  /** Live terminal captures by agent key; undefined when terminals are off. */
  panes?: Record<string, PaneView>;
  onAgentClick?: (key: string) => void;
  /** ms a bolt, flash or edit pulse stays (fading) after its operation ends. */
  linger: number;
  tl: Timeline;
  snap: Snapshot;
  clock: Clock;
  layout: CityLayout;
  positions: React.RefObject<Positions>;
  reduced: boolean;
  selected: Selection | null;
  onSelect: (s: Selection | null) => void;
}) {
  const { buildings, index, districts, cities } = layout;
  // Far out (looking at the planet), labels would pile up: hide them.
  const camera = useThree((s) => s.camera);
  const [far, setFar] = useState(false);
  const farAt = layout.size * 2.5 + 250;
  // Drones grow with the main city so they stay visible over big repos.
  const droneScale = Math.min(3, Math.max(1, Math.max(cities[0]?.w ?? 0, cities[0]?.d ?? 0) / 35));
  const bRef = useRef<THREE.InstancedMesh>(null);
  const dRef = useRef<THREE.InstancedMesh>(null);
  const [hover, setHover] = useState<number | null>(null);

  const seenMsg = useSeen();
  const seenEdit = useSeen();
  useEffect(() => {
    seenMsg.mark(tl.messages.map((m) => m.id));
    seenEdit.mark(tl.edits.map((e) => `${e.fileKey}@${e.ms}`));
  }, [tl, seenMsg, seenEdit]);

  const baseColors = useMemo(
    () => buildings.map((b) => new THREE.Color(EXT_COLORS[b.ext] ?? DEFAULT_EXT).multiplyScalar(0.9)),
    [buildings],
  );
  const dirty = useMemo(() => {
    const s = new Set<string>();
    for (const r of tl.repos) for (const d of r.dirty) s.add(fileKey(r.id, d.p));
    return s;
  }, [tl]);
  const agentColor = useMemo(() => new Map(tl.agents.map((a) => [a.key, new THREE.Color(a.color)])), [tl]);

  // Static matrices.
  useEffect(() => {
    const m = new THREE.Matrix4();
    const mesh = bRef.current;
    if (mesh) {
      buildings.forEach((b, i) => {
        m.makeScale(b.w, b.h, b.d).setPosition(b.x, b.h / 2, b.z);
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, baseColors[i]);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    const dm = dRef.current;
    if (dm) {
      const c = new THREE.Color();
      districts.forEach((d, i) => {
        const h = 0.06;
        m.makeScale(d.w, h, d.d).setPosition(d.x + d.w / 2, (d.depth + 0.5) * h, d.z + d.d / 2);
        dm.setMatrixAt(i, m);
        c.setHSL(0.6, 0.12, 0.08 + Math.min(d.depth, 6) * 0.025);
        dm.setColorAt(i, c);
      });
      dm.instanceMatrix.needsUpdate = true;
      if (dm.instanceColor) dm.instanceColor.needsUpdate = true;
      dm.computeBoundingSphere();
    }
  }, [buildings, districts, baseColors]);

  // Edit beams: a pool of light columns over freshly edited files.
  const beams = useMemo(
    () =>
      Array.from({ length: BEAMS }, () => {
        const mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.1, 0.28, 1, 10, 1, true),
          new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, depthWrite: false, side: THREE.DoubleSide }),
        );
        mesh.visible = false;
        return mesh;
      }),
    [],
  );

  // Where each agent hovers: over its focus file, else at a pad around its city.
  const homes = useMemo(() => {
    const out = new Map<string, THREE.Vector3>();
    tl.agents.forEach((a, i) => {
      const city = cities.find((c) => c.repo === a.repo) ?? cities[0];
      const cx = city ? city.x + city.w / 2 : 0;
      const cz = city ? city.z + city.d / 2 : 0;
      const r = city ? Math.max(city.w, city.d) / 2 + 5 : 10;
      const ang = (i / Math.max(tl.agents.length, 1)) * Math.PI * 2 + 0.6;
      out.set(a.key, new THREE.Vector3(cx + Math.cos(ang) * r, 9 * droneScale, cz + Math.sin(ang) * r));
    });
    return out;
  }, [tl, cities, droneScale]);

  const drones = useRef(new Map<string, THREE.Group>());
  const tmpC = useMemo(() => new THREE.Color(), []);
  const strikeC = useMemo(() => new THREE.Color(), []);
  const strikes = useRef<Strike[]>([]);
  const strikeR = 7 * droneScale;
  const target = useMemo(() => new THREE.Vector3(), []);

  useFrame((state, dt) => {
    const isFar = camera.position.length() > farAt;
    if (isFar !== far) setFar(isFar);
    const t = clock.now();
    const time = state.clock.elapsedTime;
    const mesh = bRef.current;
    const live = clock.live;

    // Recent edits per building → pulse strength.
    const pulse = new Map<number, { k: number; node: string | null }>();
    for (let i = tl.edits.length - 1, n = 0; i >= 0 && n < 400; i--, n++) {
      const e = tl.edits[i];
      const age = realAge(clock, t, seenEdit.eff(`${e.fileKey}@${e.ms}`, e.ms, live));
      if (age < 0 || age > EDIT_PULSE_MS + linger) continue;
      const bi = index.get(e.fileKey);
      if (bi === undefined) continue;
      // Decays to 40% over the pulse, then holds and fades out over the linger.
      const k = (1 - 0.6 * Math.min(1, age / EDIT_PULSE_MS)) * tailFade(age, EDIT_PULSE_MS, linger);
      if ((pulse.get(bi)?.k ?? 0) < k) pulse.set(bi, { k, node: editor(tl, snap, e) });
    }

    if (mesh) {
      const focusOf = new Map<number, string>();
      for (const [key, s] of snap.agents) {
        const bi = s.focus ? index.get(s.focus) : undefined;
        if (bi !== undefined) focusOf.set(bi, key);
      }
      const selKey = selected?.kind === "file" ? selected.key : null;
      for (let i = 0; i < buildings.length; i++) {
        const b = buildings[i];
        tmpC.copy(baseColors[i]);
        if (dirty.has(b.key)) tmpC.lerp(AMBER, 0.45);
        const h = snap.holders.get(b.key);
        // Only guessed holders: a soft grey tint, never a clash.
        if (!h && snap.maybe.has(b.key)) tmpC.lerp(GREY, 0.55);
        if (h && h.length > 1) {
          tmpC.copy(RED).multiplyScalar(reduced ? 2 : 1.2 + Math.abs(Math.sin(time * 9)) * 2.2);
        } else if (h && h.length === 1) {
          tmpC.copy(agentColor.get(h[0]) ?? WHITE).multiplyScalar(reduced ? 1.8 : 1.5 + Math.sin(time * 2 + i) * 0.25);
        }
        const f = focusOf.get(i);
        if (f && !(h && h.length)) tmpC.lerp(agentColor.get(f) ?? WHITE, 0.6).multiplyScalar(1.3);
        const p = pulse.get(i);
        if (p) tmpC.lerp(WHITE, p.k * 0.8).multiplyScalar(1 + p.k * 2.5);
        // Strike light: buildings near a fresh strike flicker in the striker's colour.
        for (const st of strikes.current) {
          const dx = b.x - st.x;
          const dz = b.z - st.z;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d < strikeR) tmpC.add(strikeC.copy(st.color).multiplyScalar(st.k * (1 - d / strikeR) * (reduced ? 1.5 : 0.6 + Math.random() * 2)));
        }
        if (i === hover || b.key === selKey) tmpC.lerp(WHITE, 0.5).multiplyScalar(1.4);
        mesh.setColorAt(i, tmpC);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    // Beams over the strongest pulses.
    const top = [...pulse.entries()].sort((a, b) => b[1].k - a[1].k).slice(0, BEAMS);
    beams.forEach((m, j) => {
      const e = top[j];
      if (!e) {
        m.visible = false;
        return;
      }
      const [bi, { k, node }] = e;
      const b = buildings[bi];
      const hgt = 10 * (reduced ? 1 : 0.4 + k * 0.6);
      m.position.set(b.x, b.h + hgt / 2, b.z);
      m.scale.set(1, hgt, 1);
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.copy((node && agentColor.get(node)) || WHITE).multiplyScalar(2.2);
      // Kept faint so the lightning bolt reads over it.
      mat.opacity = k * 0.3;
      m.visible = true;
    });

    // Drones.
    let idx = 0;
    for (const a of tl.agents) {
      const g = drones.current.get(a.key);
      if (!g) continue;
      const s = snap.agents.get(a.key);
      const bi = s?.focus ? index.get(s.focus) : undefined;
      if (bi !== undefined) {
        const b = buildings[bi];
        const off = (idx % 4) * 0.8;
        target.set(b.x + off * droneScale, b.h + 6 * droneScale, b.z + off * droneScale);
      } else target.copy(homes.get(a.key)!);
      if (!reduced) target.y += Math.sin(time * 1.4 + idx) * 0.35;
      g.position.lerp(target, reduced ? 1 : Math.min(1, dt * 2.2));
      positions.current?.set(a.key, g.position);
      const ring = g.children[1] as THREE.Mesh;
      if (ring && s?.busy && !reduced) ring.rotation.z += dt * 2.5;
      const core = g.children[0] as THREE.Mesh;
      const mat = core.material as THREE.MeshBasicMaterial;
      mat.color.set(a.color).multiplyScalar(s?.busy ? 2.4 + (reduced ? 0 : Math.sin(time * 4) * 0.4) : 0.45);
      idx++;
    }
  });

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHover(e.instanceId ?? null);
  };

  const hb = hover !== null ? buildings[hover] : null;
  const colorOf = (node: string) => tl.byKey.get(node)?.color ?? "#94a3b8";
  const towers = cities
    .map((c) => ({
      city: c,
      commits: snap.commits.filter((x: TLCommit) => x.repo === c.repo || (!x.repo && c === cities[0])),
    }))
    .filter((x) => x.commits.length > 0);

  return (
    <group>
      {/* The ground is the planet's flattened pole (sky.tsx). */}
      <instancedMesh ref={dRef} args={[undefined, undefined, Math.max(districts.length, 1)]} frustumCulled={false}>
        <boxGeometry />
        <meshStandardMaterial />
      </instancedMesh>

      <instancedMesh
        key={buildings.length}
        ref={bRef}
        args={[undefined, undefined, Math.max(buildings.length, 1)]}
        onPointerMove={onMove}
        onPointerOut={() => setHover(null)}
        onClick={(e) => {
          e.stopPropagation();
          if (e.instanceId !== undefined) onSelect({ kind: "file", key: buildings[e.instanceId].key });
        }}
      >
        <boxGeometry />
        <meshStandardMaterial toneMapped={false} roughness={0.55} metalness={0.15} />
      </instancedMesh>

      {beams.map((m, i) => (
        <primitive key={i} object={m} />
      ))}

      {hb && (
        <OverlayLabel position={[hb.x, hb.h + 0.6, hb.z]} center zIndexRange={[30, 0]} style={{ pointerEvents: "none" }}>
          <div className="whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-white">{hb.path}</div>
        </OverlayLabel>
      )}

      {cities.map((c) => (
        <OverlayLabel key={c.repo} position={[c.x, 0.2, c.z + c.d + 1.5]} zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
          <div className={`whitespace-nowrap text-xs font-semibold tracking-wide text-white/70 uppercase ${far ? "hidden" : ""}`}>{c.name}</div>
        </OverlayLabel>
      ))}
      {districts
        .filter((d) => d.depth === 0 && d.w * d.d > 30)
        .map((d) => (
          <OverlayLabel key={`${d.repo}:${d.dir}`} position={[d.x + 0.3, 0.3, d.z + 0.6]} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
            <div className={`whitespace-nowrap font-mono text-[10px] text-white/45 ${far ? "hidden" : ""}`}>{d.dir}/</div>
          </OverlayLabel>
        ))}

      {tl.agents.map((a) => (
        <group
          key={a.key}
          ref={(g) => {
            if (g) drones.current.set(a.key, g);
            else drones.current.delete(a.key);
          }}
          position={homes.get(a.key)!.toArray()}
          scale={droneScale}
          onClick={(e) => {
            e.stopPropagation();
            onSelect({ kind: "agent", key: a.key });
          }}
        >
          <mesh>
            <sphereGeometry args={[1.1, 24, 24]} />
            <meshBasicMaterial color={a.color} toneMapped={false} />
          </mesh>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[1.9, 0.12, 8, 48, Math.PI * 1.6]} />
            <meshBasicMaterial color={new THREE.Color(a.color).multiplyScalar(1.4)} toneMapped={false} />
          </mesh>
          <AgentLabel
            name={a.name}
            color={a.color}
            snapAgent={snap.agents.get(a.key)}
            live={clock.live}
            onClick={() => (onAgentClick ? onAgentClick(a.key) : onSelect({ kind: "agent", key: a.key }))}
            term={panes ? (panes[a.key] ?? null) : undefined}
            recent={
              panes && !panes[a.key]?.text
                ? a.events
                    .filter((e) => e.ms <= snap.t)
                    .slice(-3)
                    .map((e) => `${e.tool}${e.path ? ` ${e.path}` : ""}`)
                : undefined
            }
            selected={selected?.kind === "agent" && selected.key === a.key}
            hidden={far}
          />
        </group>
      ))}

      <Lightning
        tl={tl}
        snap={snap}
        clock={clock}
        layout={layout}
        positions={positions}
        reduced={reduced}
        scale={droneScale}
        strikes={strikes}
        linger={linger}
      />

      <MessageArcs tl={tl} clock={clock} positions={positions} eff={(m) => seenMsg.eff(m.id, m.ms, clock.live)} reduced={reduced} />

      {towers.map(({ city, commits }) => (
        <CommitTower
          key={city.repo}
          commits={commits}
          clock={clock}
          colorOf={colorOf}
          position={[city.x - 3, 0, city.z - 3]}
          reduced={reduced}
          label={`${city.name} · ${commits.length} commits`}
          onSelect={(c) => onSelect({ kind: "commit", hash: c.hash })}
        />
      ))}
    </group>
  );
}
