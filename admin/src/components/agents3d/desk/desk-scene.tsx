"use client";

import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import { Follow, type Positions, useSeen } from "../parts";
import type { SceneProps } from "../scene";
import { rawBeats, scheduleBeats } from "./activity";
import { activitiesAt, castAt, DeskAgents, editingFiles } from "./agents";
import { CommitTower, DeskTop, Lamp, MiniCityView, Mug, OriginBeacon, Papers } from "./props";
import { Whiteboard } from "./whiteboard";
import { BOARD, miniCities } from "./world";

/**
 * Desk mode: the repo cities as clay miniatures on an office desk, and a clay
 * character per agent acting out what it does. A drop-in for <Scene> (same
 * props); its own canvas, room lighting and camera, no sky or planet.
 */
export default function DeskScene(props: SceneProps) {
  const { bloom, onSelect } = props;
  const small = typeof window !== "undefined" && window.innerWidth < 800;
  return (
    <Canvas
      key={props.frameKey ?? ""}
      shadows={{ type: THREE.PCFShadowMap }}
      camera={{ position: [0, 23, 41], fov: 40, near: 0.1, far: 400 }}
      gl={{ antialias: true }}
      dpr={[1, 1.5]}
      scene={{ environmentIntensity: 0.3 }}
      onPointerMissed={() => onSelect(null)}
    >
      <color attach="background" args={["#1d1a17"]} />
      <Room />
      <hemisphereLight args={["#fff7ed", "#5b4636", 0.55]} />
      <directionalLight
        position={[-10, 24, 16]}
        intensity={2.2}
        color="#fff4e6"
        castShadow
        shadow-mapSize={small ? [1024, 1024] : [2048, 2048]}
        shadow-bias={-0.0004}
        shadow-radius={5}
        shadow-camera-left={-22}
        shadow-camera-right={22}
        shadow-camera-top={18}
        shadow-camera-bottom={-18}
        shadow-camera-near={1}
        shadow-camera-far={70}
      />
      <directionalLight position={[8, 6, -10]} intensity={0.8} color="#bcd4ff" />
      <Stage {...props} />
      <OrbitControls makeDefault target={[0, 6, -6]} enableDamping maxPolarAngle={Math.PI / 2.1} minDistance={5} maxDistance={90} />
      {bloom && (
        <EffectComposer>
          <Bloom mipmapBlur luminanceThreshold={0.9} luminanceSmoothing={0.2} intensity={0.9} />
        </EffectComposer>
      )}
    </Canvas>
  );
}

/** Soft image-based light from three's RoomEnvironment: it gives clay its sheen. */
function Room() {
  const gl = useThree((s) => s.gl);
  const env = useMemo(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const tex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    return tex;
  }, [gl]);
  useEffect(() => () => env.dispose(), [env]);
  return <primitive object={env} attach="environment" />;
}

function Stage(props: SceneProps) {
  const { tl, snap, clock, layout, reduced, selected, onSelect, onAgentClick, followKey, flyTo } = props;
  const positions = useRef<Positions>(new Map());
  const colorOf = useMemo(() => {
    const m = new Map(tl.agents.map((a) => [a.key, a.color]));
    return (k: string) => m.get(k) ?? "#94a3b8";
  }, [tl]);
  const mini = useMemo(() => miniCities(layout), [layout]);

  // Beats: one-shot animations, queued per agent (see activity.ts). In live mode a
  // beat is due when its event was first seen, as data arrives up to a poll late.
  const seen = useSeen();
  const raw = useMemo(() => {
    const r = rawBeats(tl);
    seen.mark([...r.values()].flatMap((list) => list.map((x) => x.id)));
    return r;
  }, [tl, seen]);
  const live = clock.live;
  const scale = live ? 1 : clock.speed;
  const beats = useMemo(
    () => new Map([...raw].map(([k, list]) => [k, scheduleBeats(list, scale, (id, ms) => seen.eff(id, ms, live))])),
    [raw, scale, live, seen],
  );
  const acts = useMemo(() => activitiesAt(tl, beats, snap.t, snap.live), [tl, beats, snap]);
  const editing = useMemo(() => editingFiles(tl, acts, colorOf), [tl, acts, colorOf]);
  // Who sits at the table; the array only changes when someone joins or leaves.
  const castKey = castAt(tl, snap.t, snap.live)
    .map((a) => a.key)
    .join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cast = useMemo(() => castAt(tl, snap.t, snap.live), [tl, castKey]);
  const [boardFly, setBoardFly] = useState(0);
  return (
    <>
      <DeskTop />
      <Papers />
      <Mug reduced={reduced} />
      <Lamp />
      <CommitTower commits={snap.commits} clock={clock} colorOf={colorOf} reduced={reduced} onSelect={onSelect} />
      <OriginBeacon commits={snap.commits} clock={clock} reduced={reduced} />
      <MiniCityView tl={tl} snap={snap} layout={layout} mini={mini} colorOf={colorOf} editing={editing} onSelect={onSelect} />
      <Whiteboard snap={snap} colorOf={colorOf} reduced={reduced} onSelect={onSelect} onBoardClick={() => setBoardFly((n) => n + 1)} />
      <DeskAgents
        cast={cast}
        snap={snap}
        clock={clock}
        layout={layout}
        mini={mini}
        beats={beats}
        acts={acts}
        colorOf={colorOf}
        reduced={reduced}
        selected={selected}
        onSelect={onSelect}
        onAgentClick={onAgentClick}
        positions={positions}
      />
      <Follow positions={positions} followKey={followKey} reduced={reduced} />
      <FlyTo flyTo={flyTo} board={boardFly} positions={positions} reduced={reduced} />
    </>
  );
}

const FLY_MS = 800;
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

/** Eases the camera to an agent (close enough to see what it's acting out), or to the whiteboard. */
function FlyTo({
  flyTo,
  board,
  positions,
  reduced,
}: {
  flyTo?: SceneProps["flyTo"];
  board: number;
  positions: React.RefObject<Positions>;
  reduced: boolean;
}) {
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null;
  const camera = useThree((s) => s.camera);
  const f = useRef({ active: false, t0: 0, fromPos: new THREE.Vector3(), fromTarget: new THREE.Vector3(), toPos: new THREE.Vector3(), toTarget: new THREE.Vector3() });

  const start = (toPos: THREE.Vector3, toTarget: THREE.Vector3) => {
    const flight = f.current;
    if (!controls) return;
    flight.fromPos.copy(camera.position);
    flight.fromTarget.copy(controls.target);
    flight.toTarget.copy(toTarget);
    flight.toPos.copy(toPos);
    flight.t0 = performance.now();
    flight.active = !reduced;
    if (reduced) {
      camera.position.copy(toPos);
      controls.target.copy(toTarget);
      controls.update();
    }
  };

  useEffect(() => {
    const p = flyTo && positions.current?.get(flyTo.key);
    if (!p || !controls) return;
    const dir = camera.position.clone().sub(controls.target);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    const dist = 16;
    dir.normalize().multiplyScalar(Math.cos(0.6) * dist);
    dir.y = Math.sin(0.6) * dist;
    start(p.clone().add(dir), p.clone());
    // Only a new flight (n) starts this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyTo?.n, controls]);

  useEffect(() => {
    if (!board) return;
    const c = new THREE.Vector3(BOARD.x, BOARD.y + BOARD.h / 2, BOARD.z);
    start(c.clone().add(new THREE.Vector3(0, 1.5, BOARD.w * 0.85)), c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board]);

  useFrame(() => {
    const flight = f.current;
    if (!flight.active || !controls) return;
    const x = Math.min(1, (performance.now() - flight.t0) / FLY_MS);
    camera.position.lerpVectors(flight.fromPos, flight.toPos, ease(x));
    controls.target.lerpVectors(flight.fromTarget, flight.toTarget, ease(x));
    controls.update();
    if (x >= 1) flight.active = false;
  });
  return null;
}
