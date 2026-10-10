"use client";

import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import type { BrowserSession } from "@/lib/browsers";

import { useFrameOnResize, useWantFrame } from "../frame-governor";
import { Follow, type Positions, useSeen } from "../parts";
import { useBrowsers } from "../use-browsers";
import type { SceneProps } from "../scene";
import { rawBeats, scheduleBeats } from "./activity";
import { activitiesAt, castAt, DeskAgents, editingFiles, guestsAt } from "./agents";
import { DeskBrowsers } from "./browsers";
import { CommitTower, DeskTop, Lamp, MiniCityView, Mug, OriginBeacon, Papers } from "./props";
import { DeskLinks } from "./links";
import { GAUGE_COLUMN_W } from "./gauges";
import { Whiteboard } from "./whiteboard";
import { BOARD, miniCities } from "./world";

/**
 * Desk mode: the repo cities as clay miniatures on an office desk, and a clay
 * character per agent acting out what it does. A drop-in for <Scene> (same
 * props); its own canvas, room lighting and camera, no sky or planet.
 */
const GUESTS_KEY = "admin.agents3d.desk.guests";
/** The default camera; Escape with nothing open flies back to it (resetCam). */
const HOME = { pos: new THREE.Vector3(0, 25, 45), target: new THREE.Vector3(0, 6, -6) };

export default function DeskScene(props: SceneProps) {
  const { bloom, onSelect } = props;
  // Guests (sessions nobody named) stay off the table unless asked for; remembered.
  const [guests, setGuests] = useState(() => localStorage.getItem(GUESTS_KEY) === "1");
  const guestCount = guestsAt(props.tl, props.snap.t, props.snap.live).length;
  const toggleGuests = (on: boolean) => {
    setGuests(on);
    localStorage.setItem(GUESTS_KEY, on ? "1" : "0");
  };
  const small = typeof window !== "undefined" && window.innerWidth < 800;
  // The whiteboard close-ups: the whole board (col -1) or one column; `n` starts a new flight.
  const [board, setBoard] = useState<BoardFocus>({ n: 0, col: -1 });
  const onBoard = (col: number) => setBoard((b) => ({ n: b.n + 1, col }));
  // Esc (or a click on the background) from a column close-up goes back to the whole board.
  // Captured and marked as used, so the view's own Escape (back to the default camera) waits for the next press.
  useEffect(() => {
    if (board.col < 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      setBoard((b) => ({ n: b.n + 1, col: -1 }));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [board.col]);
  return (
    <div className="relative h-full w-full">
      {/* Frames on demand: whatever animates asks for them (useWantFrame). With bloom the
          composer antialiases (4× MSAA), so the canvas doesn't; `gl` is read once, hence the key. */}
      <Canvas
        key={`${props.frameKey ?? ""}:${bloom ? "bloom" : "aa"}`}
        frameloop="demand"
        shadows={{ type: THREE.PCFShadowMap }}
        camera={{ position: HOME.pos.toArray(), fov: 40, near: 0.1, far: 400 }}
        gl={{ antialias: !bloom }}
        dpr={[1, 1.5]}
        scene={{ environmentIntensity: 0.3 }}
        onPointerMissed={() => {
          onSelect(null);
          if (board.col >= 0) onBoard(-1);
        }}
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
          shadow-camera-left={-25}
          shadow-camera-right={25}
          shadow-camera-top={21}
          shadow-camera-bottom={-21}
          shadow-camera-near={1}
          shadow-camera-far={70}
        />
        <directionalLight position={[8, 6, -10]} intensity={0.8} color="#bcd4ff" />
        <Stage {...props} board={board} onBoard={onBoard} guests={guests} />
        <OrbitControls makeDefault target={HOME.target.toArray()} enableDamping maxPolarAngle={Math.PI / 2.1} minDistance={5} maxDistance={90} />
        {bloom && (
          <EffectComposer multisampling={4}>
            <Bloom mipmapBlur luminanceThreshold={0.9} luminanceSmoothing={0.2} intensity={0.9} resolutionScale={0.5} />
          </EffectComposer>
        )}
      </Canvas>
      {guestCount > 0 && (
        <label className="absolute right-2 bottom-2 flex cursor-pointer items-center gap-1.5 rounded bg-black/50 px-2 py-0.5 text-[10px] text-white/75">
          <input type="checkbox" checked={guests} onChange={(e) => toggleGuests(e.target.checked)} />
          Show guests ({guestCount})
        </label>
      )}
    </div>
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

type BoardFocus = { n: number; col: number };
const NO_BROWSERS: BrowserSession[] = [];

function Stage(props: SceneProps & { board: BoardFocus; onBoard: (col: number) => void; guests: boolean }) {
  const { tl, snap, clock, layout, reduced, selected, onSelect, onAgentClick, followKey, flyTo, resetCam, linger, board, onBoard, guests } = props;
  const positions = useRef<Positions>(new Map());
  // A still scene would stay blank after a resize (it clears the canvas): redraw once.
  useFrameOnResize();
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
  const castKey = castAt(tl, snap.t, snap.live, guests)
    .map((a) => a.key)
    .join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cast = useMemo(() => castAt(tl, snap.t, snap.live, guests), [tl, castKey]);
  // Who has a browser open (polled every 5 s, live only: a replay shows the past, browsers are now).
  const browsers = useBrowsers(snap.live);
  return (
    <>
      <DeskTop />
      <Papers />
      <Mug reduced={reduced} />
      <Lamp />
      <CommitTower commits={snap.commits} clock={clock} colorOf={colorOf} reduced={reduced} onSelect={onSelect} />
      <OriginBeacon commits={snap.commits} clock={clock} reduced={reduced} />
      <MiniCityView tl={tl} snap={snap} layout={layout} mini={mini} colorOf={colorOf} editing={editing} reduced={reduced} onSelect={onSelect} />
      <Whiteboard
        snap={snap}
        tasks={tl.tasks}
        colorOf={colorOf}
        reduced={reduced}
        onSelect={onSelect}
        onBoardClick={() => onBoard(-1)}
        onColumnClick={onBoard}
      />
      <DeskBrowsers cast={cast} sessions={snap.live ? browsers : NO_BROWSERS} colorOf={colorOf} />
      <DeskLinks cast={cast} snap={snap} clock={clock} layout={layout} mini={mini} linger={linger} colorOf={colorOf} reduced={reduced} />
      <DeskAgents
        cast={cast}
        messages={tl.messages}
        linger={linger}
        eff={(id, ms) => seen.eff(id, ms, live)}
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
      <FlyTo flyTo={flyTo} resetCam={resetCam} board={board} positions={positions} reduced={reduced} />
    </>
  );
}

const FLY_MS = 800;
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

/** Eases the camera to an agent (close enough to see what it's acting out), to the whiteboard, or home. */
function FlyTo({
  flyTo,
  resetCam,
  board,
  positions,
  reduced,
}: {
  flyTo?: SceneProps["flyTo"];
  resetCam?: number;
  board: BoardFocus;
  positions: React.RefObject<Positions>;
  reduced: boolean;
}) {
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null;
  const camera = useThree((s) => s.camera);
  const want = useWantFrame();
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
    want(60);
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

  // Each new value (Escape with nothing open) flies back to the default camera.
  useEffect(() => {
    if (resetCam) start(HOME.pos, HOME.target);
    // Only a new request starts this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetCam, controls]);

  useEffect(() => {
    if (!board.n) return;
    const c = new THREE.Vector3(BOARD.x, BOARD.y + BOARD.h / 2, BOARD.z);
    if (board.col < 0) {
      // The whole board, with the server dials on its right edge.
      c.x += GAUGE_COLUMN_W / 2;
      start(c.clone().add(new THREE.Vector3(0, 1.5, (BOARD.w + GAUGE_COLUMN_W) * 0.85)), c);
    } else {
      // Face one column, close enough to read its post-its.
      c.x = BOARD.x - BOARD.w / 2 + (BOARD.w / 3) * (board.col + 0.5);
      start(c.clone().add(new THREE.Vector3(0, 0.4, BOARD.h * 1.25)), c);
    }
    // Only a new flight (n) starts this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.n]);

  useFrame(() => {
    const flight = f.current;
    if (!flight.active || !controls) return;
    const x = Math.min(1, (performance.now() - flight.t0) / FLY_MS);
    camera.position.lerpVectors(flight.fromPos, flight.toPos, ease(x));
    controls.target.lerpVectors(flight.fromTarget, flight.toTarget, ease(x));
    controls.update();
    if (x >= 1) flight.active = false;
    else want(60);
  });
  return null;
}
