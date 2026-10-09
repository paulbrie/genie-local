"use client";

import { OrbitControls, Stars } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { useRef } from "react";
import type * as THREE from "three";

import type { Snapshot, Timeline } from "@/lib/agents3d-timeline";
import type { CityLayout } from "@/lib/city-layout";

import { CityView } from "./city-view";
import type { Clock } from "./clock";
import { Follow, type Positions } from "./parts";

export type Selection =
  | { kind: "agent"; key: string }
  | { kind: "file"; key: string }
  | { kind: "commit"; hash: string }
  | { kind: "task"; key: string };

export type SceneProps = {
  tl: Timeline;
  snap: Snapshot;
  clock: Clock;
  layout: CityLayout;
  followKey: string | null;
  bloom: boolean;
  reduced: boolean;
  selected: Selection | null;
  onSelect: (s: Selection | null) => void;
  /** Changing it remounts the canvas, re-framing the camera (e.g. a new project selection). */
  frameKey?: string;
  /** Start the camera here instead of the default framing. */
  camera?: { position: [number, number, number]; target: [number, number, number] };
};

/** Frame the main city (the repo with the most work), not the whole map. */
function cameraFor(layout: CityLayout): { position: [number, number, number]; target: [number, number, number] } {
  const c = layout.cities[0];
  const cx = c ? c.x + c.w / 2 : 0;
  const s = c ? Math.max(c.w, c.d) : layout.size;
  return { position: [cx, s * 0.9 + 18, s * 1.1 + 22], target: [cx, 0, 0] };
}

export default function Scene(props: SceneProps) {
  const { layout, bloom, reduced, onSelect } = props;
  const cam = props.camera ?? cameraFor(layout);

  return (
    <Canvas
      // Remount on a new project selection, so the camera re-frames it.
      key={props.frameKey ?? ""}
      camera={{ position: cam.position, fov: 50, near: 0.1, far: 4000 }}
      gl={{ antialias: true }}
      dpr={[1, 2]}
      onPointerMissed={() => onSelect(null)}
      onCreated={({ gl }) => {
        (gl as THREE.WebGLRenderer).setClearColor("#03050a");
      }}
    >
      <fog attach="fog" args={["#03050a", 60, layout.size * 2.5 + 150]} />
      <ambientLight intensity={0.55} />
      <hemisphereLight args={["#9db4ff", "#0a0a12", 0.5]} />
      <directionalLight position={[40, 80, 30]} intensity={1.5} />
      {!reduced && <Stars radius={600} depth={80} count={2500} factor={6} fade speed={0.4} />}

      <Stage {...props} />

      <OrbitControls
        makeDefault
        target={cam.target}
        enableDamping
        maxPolarAngle={Math.PI / 2.05}
        maxDistance={layout.size * 3 + 200}
      />
      {bloom && (
        <EffectComposer>
          <Bloom mipmapBlur luminanceThreshold={0.85} luminanceSmoothing={0.2} intensity={1.4} />
        </EffectComposer>
      )}
    </Canvas>
  );
}

/** The city plus the follow camera. Inside the Canvas, so it remounts (fresh positions) with it. */
function Stage(props: SceneProps) {
  const positions = useRef<Positions>(new Map());
  return (
    <>
      <CityView {...props} positions={positions} />
      <Follow positions={positions} followKey={props.followKey} reduced={props.reduced} />
    </>
  );
}
