"use client";

import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { useEffect, useRef } from "react";
import * as THREE from "three";

import type { Snapshot, Timeline } from "@/lib/agents3d-timeline";
import type { CityLayout } from "@/lib/city-layout";

import { CityView } from "./city-view";
import type { Clock } from "./clock";
import { useFrameOnResize, useWantFrame } from "./frame-governor";
import { Follow, type Positions } from "./parts";
import { Planet, planetFor, SkyDome, WorldLights } from "./sky";
import type { PaneView } from "./use-panes";

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
  /** ms effects linger (fading) after an operation ends. */
  linger: number;
  /** Changing it remounts the canvas, re-framing the camera (e.g. a new project selection). */
  frameKey?: string;
  /** Fly the camera to this agent (a new `n` starts a new flight). */
  flyTo?: { key: string; n: number } | null;
  /** Live terminal captures by agent key; undefined when terminals are off. */
  panes?: Record<string, PaneView>;
  /** An agent's card was clicked. */
  onAgentClick?: (key: string) => void;
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
  // Far enough out to see the planet's curve and limb, but not lose the cities.
  const maxDist = Math.max(layout.size * 3 + 200, planetFor(layout).radius * 0.9);

  return (
    <Canvas
      // Remount on a new project selection, so the camera re-frames it.
      key={props.frameKey ?? ""}
      camera={{ position: cam.position, fov: 50, near: 0.5, far: 9000 }}
      // Frames on demand: drawn when something moves or changes (frame-governor.ts).
      frameloop="demand"
      gl={{ antialias: true }}
      // 1.5 is sharp enough for this scene on a 2× screen at ~56% of the pixels.
      dpr={[1, 1.5]}
      onPointerMissed={() => onSelect(null)}
      onCreated={({ gl }) => {
        (gl as THREE.WebGLRenderer).setClearColor("#03050a");
      }}
    >
      {/* A light haze for depth; it never hides the cities at the zoom-out limit. */}
      <fog attach="fog" args={["#05070d", maxDist * 0.5, maxDist * 2.2]} />
      <WorldLights />
      <SkyDome reduced={reduced} />
      <Planet layout={layout} />

      <Stage {...props} />

      <OrbitControls
        makeDefault
        target={cam.target}
        enableDamping
        maxPolarAngle={Math.PI / 2.05}
        maxDistance={maxDist}
      />
      {bloom && (
        <EffectComposer multisampling={4}>
          <Bloom mipmapBlur luminanceThreshold={0.85} luminanceSmoothing={0.2} intensity={1.4} />
        </EffectComposer>
      )}
    </Canvas>
  );
}

/** The city plus the follow camera. Inside the Canvas, so it remounts (fresh positions) with it. */
function Stage(props: SceneProps) {
  const positions = useRef<Positions>(new Map());
  useFrameOnResize();
  return (
    <>
      <CityView {...props} positions={positions} />
      <Follow positions={positions} followKey={props.followKey} reduced={props.reduced} />
      <FlyTo {...props} positions={positions} />
    </>
  );
}

const FLY_MS = 800;
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

/**
 * Eases the camera to an agent: frames the drone and the file under its bolt
 * (its focus) at a comfortable distance, keeping the current viewing
 * direction, then holds. Reduced motion jumps instead.
 */
function FlyTo({ flyTo, snap, layout, reduced, positions }: SceneProps & { positions: React.RefObject<Positions> }) {
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null;
  const camera = useThree((s) => s.camera);
  const want = useWantFrame();
  const flightRef = useRef({
    active: false,
    t0: 0,
    fromPos: new THREE.Vector3(),
    fromTarget: new THREE.Vector3(),
    toPos: new THREE.Vector3(),
    toTarget: new THREE.Vector3(),
  });

  useEffect(() => {
    const flight = flightRef.current;
    if (!flyTo || !controls) return;
    const p = positions.current?.get(flyTo.key);
    if (!p) return;
    const focus = snap.agents.get(flyTo.key)?.focus;
    const bi = focus ? layout.index.get(focus) : undefined;
    const b = bi !== undefined ? layout.buildings[bi] : null;
    // Centre between the drone and its target; distance grows with their separation.
    const center = b ? new THREE.Vector3(b.x, b.h, b.z).add(p).multiplyScalar(0.5) : p.clone();
    const sep = b ? p.distanceTo(new THREE.Vector3(b.x, b.h, b.z)) : 0;
    const dist = Math.max(22, sep * 2.2);
    const dir = camera.position.clone().sub(controls.target);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize().multiplyScalar(Math.cos(0.62) * dist);
    dir.y = Math.sin(0.62) * dist; // ~35° above the horizon
    flight.fromPos.copy(camera.position);
    flight.fromTarget.copy(controls.target);
    flight.toTarget.copy(center);
    flight.toPos.copy(center).add(dir);
    flight.t0 = performance.now();
    flight.active = true;
    if (reduced) {
      camera.position.copy(flight.toPos);
      controls.target.copy(flight.toTarget);
      controls.update();
      flight.active = false;
    }
    want(60);
    // Only a new flight (n) starts this; snapshot ticks must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyTo?.n, controls]);

  useFrame(() => {
    const flight = flightRef.current;
    if (!flight.active || !controls) return;
    const x = Math.min(1, (performance.now() - flight.t0) / FLY_MS);
    const k = ease(x);
    camera.position.lerpVectors(flight.fromPos, flight.toPos, k);
    controls.target.lerpVectors(flight.fromTarget, flight.toTarget, k);
    controls.update();
    if (x >= 1) flight.active = false;
    else want(60);
  });
  return null;
}
