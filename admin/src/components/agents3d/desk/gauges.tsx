"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import { BASE_PATH } from "@/lib/config";

import { useWantFrame } from "../frame-governor";
import {
  type CoreBar,
  coreBarsFor,
  coreBarsKey,
  coreCells,
  cpuLevel,
  type Dial,
  dialKey,
  dialsFor,
  type Eased,
  easedAt,
  easing,
  faceKey,
  LEVEL_COLORS,
  retarget,
  type StatsReading,
} from "./gauge-levels";
import { BOARD } from "./world";

/** How often the dials read /api/stats (paused while the tab is hidden). */
const POLL_MS = 5000;
/** A reading older than this (the stats daemon stopped) shows as no data. */
const STALE_MS = 60_000;
/** Dial radius and the gap between dials (world units). */
const DIAL = { r: 1.8, gap: 0.35 };
/** The column of dials on the whiteboard's right edge (world units wide). */
export const GAUGE_COLUMN_W = 4.5;
const PX = 512;
/** The per-core bars: a strip under the CPU dial, `above` below it (world units). */
const STRIP = { w: GAUGE_COLUMN_W - 0.5, h: 1.5, above: 0.2 };
const STRIP_PX = { w: 512, h: Math.round((512 * STRIP.h) / STRIP.w) };
/** Top to bottom: the CPU dial, its core strip, MEM, DISK; centred on the board's middle. */
const COLUMN_H = 6 * DIAL.r + STRIP.above + STRIP.h + 2 * DIAL.gap;
const CPU_Y = COLUMN_H / 2 - DIAL.r;
const STRIP_Y = CPU_Y - DIAL.r - STRIP.above - STRIP.h / 2;
const MEM_Y = STRIP_Y - STRIP.h / 2 - DIAL.gap - DIAL.r;
const DIAL_Y = [CPU_Y, MEM_Y, MEM_Y - 2 * DIAL.r - DIAL.gap];

/**
 * The dials' and core bars' readings: /api/stats every POLL_MS while the tab is
 * visible. Each state changes only when what it shows changes, so nothing
 * re-renders in between.
 */
function useServerStats(): { dials: Dial[]; bars: CoreBar[] } {
  const [dials, setDials] = useState(() => dialsFor(null));
  const [bars, setBars] = useState(() => coreBarsFor(null));
  useEffect(() => {
    let active = true;
    let id: ReturnType<typeof setInterval> | undefined;
    const show = (s: StatsReading | null) => {
      const next = dialsFor(s);
      setDials((prev) => (prev.map(dialKey).join("~") === next.map(dialKey).join("~") ? prev : next));
      setBars((prev) => {
        const b = coreBarsFor(s, prev.length);
        return coreBarsKey(b) === coreBarsKey(prev) ? prev : b;
      });
    };
    const load = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/stats`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const s = (await res.json()) as StatsReading & { ts?: number };
        if (active) show(s.ts && Date.now() - s.ts > STALE_MS ? null : s);
      } catch {
        if (active) show(null);
      }
    };
    const start = () => {
      if (id !== undefined || document.hidden) return;
      load();
      id = setInterval(load, POLL_MS);
    };
    const stop = () => {
      clearInterval(id);
      id = undefined;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return { dials, bars };
}

/** The scale runs 270°, from bottom left (0) over the top to bottom right (100). */
const angleOf = (pct: number) => ((135 + (pct / 100) * 270) * Math.PI) / 180;
/** Canvas pixels on a dial's face to world units. */
const K = DIAL.r / (PX / 2);

/** The face: rim, scale, label and what's free. The needle and the number are drawn over it, so it isn't repainted as they move. */
function paintFace(c: HTMLCanvasElement, d: Dial) {
  const g = c.getContext("2d")!;
  const m = PX / 2;
  g.clearRect(0, 0, PX, PX);
  g.fillStyle = "#0f172a";
  g.fillRect(0, 0, PX, PX);
  // The rim in the dial's level colour.
  g.lineWidth = 26;
  g.strokeStyle = LEVEL_COLORS[d.level];
  g.beginPath();
  g.arc(m, m, m - 13, 0, Math.PI * 2);
  g.stroke();
  // The scale: green, then amber and red zones, with a tick every 10.
  const band = (from: number, to: number, color: string) => {
    if (to <= from) return;
    g.strokeStyle = color;
    g.lineWidth = 14;
    g.beginPath();
    g.arc(m, m, m - 52, angleOf(from), angleOf(to));
    g.stroke();
  };
  band(0, d.zones[0], "#14532d");
  band(d.zones[0], d.zones[1], "#b45309");
  band(d.zones[1], 100, "#b91c1c");
  g.strokeStyle = "#cbd5e1";
  g.lineWidth = 4;
  for (let p = 0; p <= 100; p += 10) {
    const a = angleOf(p);
    g.beginPath();
    g.moveTo(m + Math.cos(a) * (m - 64), m + Math.sin(a) * (m - 64));
    g.lineTo(m + Math.cos(a) * (m - 88), m + Math.sin(a) * (m - 88));
    g.stroke();
  }
  // Label and what's free, around the number's place at the bottom.
  g.textAlign = "center";
  g.fillStyle = "#94a3b8";
  g.font = "bold 44px ui-sans-serif, system-ui, sans-serif";
  g.fillText(d.label, m, m - 62);
  if (d.sub) {
    g.fillStyle = "#cbd5e1";
    g.font = "32px ui-sans-serif, system-ui, sans-serif";
    g.fillText(d.sub, m, m + 178);
  }
}

/** The number (eased with the needle), on its own small texture over the face. */
const NUM_PX = { w: 288, h: 112 };
function paintNumber(n: { c: HTMLCanvasElement; t: THREE.Texture }, text: string) {
  n.t.needsUpdate = true;
  const g = n.c.getContext("2d")!;
  g.clearRect(0, 0, NUM_PX.w, NUM_PX.h);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "#f8fafc";
  g.font = "bold 88px ui-sans-serif, system-ui, sans-serif";
  g.fillText(text, NUM_PX.w / 2, NUM_PX.h / 2 + 4);
}

/** The strip's background and empty tracks (grey without data), repainted when the count or greyness changes; the fills are bars of their own, over it. */
const STRIP_PAD = 14;
function paintTracks(strip: { c: HTMLCanvasElement; t: THREE.Texture; key: string }, n: number, grey: boolean) {
  const key = `${n}|${grey}`;
  if (strip.key === key) return;
  strip.key = key;
  strip.t.needsUpdate = true;
  const g = strip.c.getContext("2d")!;
  const { w, h } = STRIP_PX;
  g.clearRect(0, 0, w, h);
  g.fillStyle = "#0f172a";
  g.beginPath();
  g.roundRect(0, 0, w, h, 18);
  g.fill();
  const iw = w - 2 * STRIP_PAD;
  const ih = h - 2 * STRIP_PAD;
  g.fillStyle = grey ? `${LEVEL_COLORS.none}80` : "#1e293b";
  for (const cell of coreCells(n)) g.fillRect(STRIP_PAD + cell.x * iw, STRIP_PAD + cell.y * ih, cell.w * iw, cell.h * ih);
}

function canvasTexture(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return { c, t };
}

const faceGeo = new THREE.CircleGeometry(DIAL.r, 64);
const bezelGeo = new THREE.TorusGeometry(DIAL.r, 0.12, 12, 64);
const panelGeo = new RoundedBoxGeometry(GAUGE_COLUMN_W, BOARD.h + 0.8, 0.4, 3, 0.15);
const numGeo = new THREE.PlaneGeometry(NUM_PX.w * K, NUM_PX.h * K);
/** The needle as on the face before: from 24 px behind the hub to 80 px short of the edge, 10 px wide; it turns about the hub. */
const needleGeo = new THREE.BoxGeometry((PX / 2 - 80 + 24) * K, 10 * K, 0.004).translate(((PX / 2 - 80 - 24) / 2) * K, 0, 0);
const hubGeo = new THREE.CircleGeometry(18 * K, 24);
const stripGeo = new THREE.PlaneGeometry(STRIP.w, STRIP.h);
const stripBezelGeo = new RoundedBoxGeometry(STRIP.w + 0.24, STRIP.h + 0.24, 0.1, 2, 0.08);
/** A core's fill: a unit square standing on its bottom edge, scaled per bar. */
const fillGeo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
/** World units per strip pixel (the strip's texture has the strip's aspect). */
const SK = STRIP.w / STRIP_PX.w;

/** The dial numbers' text for a value. */
const numText = (v: number | null) => (v === null ? "—" : `${Math.round(v)}%`);

/**
 * Server CPU, memory and disk as three round dials in a column on the
 * whiteboard's right edge (whiteboard-local coordinates), with a bar per CPU
 * core under the CPU dial. A new reading eases each needle, number and bar to
 * it (EASE_MS, from wherever it is), asking for frames only while one moves.
 * A face is repainted only when its rim, scale or text changes, a number only
 * when the shown integer does, and the bars are scaled, not repainted.
 */
export function ServerGauges({ reduced }: { reduced: boolean }) {
  const { dials, bars } = useServerStats();
  const invalidate = useThree((s) => s.invalidate);
  const want = useWantFrame();
  const faces = useMemo(() => [0, 1, 2].map(() => ({ ...canvasTexture(PX, PX), key: "" })), []);
  const nums = useMemo(() => [0, 1, 2].map(() => ({ ...canvasTexture(NUM_PX.w, NUM_PX.h), text: "" })), []);
  const strip = useMemo(() => ({ ...canvasTexture(STRIP_PX.w, STRIP_PX.h), key: "" }), []);
  useEffect(
    () => () => {
      for (const f of [...faces, ...nums, strip]) f.t.dispose();
    },
    [faces, nums, strip],
  );
  const needles = useRef<(THREE.Mesh | null)[]>([]);
  const fills = useRef<THREE.InstancedMesh>(null);
  // What eases: a needle per dial (null: no data, no needle) and a fill per core.
  const motion = useRef<{ dials: (Eased | null)[]; cores: (Eased | null)[] }>({ dials: [null, null, null], cores: [] });
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), c: new THREE.Color() }), []);

  // A new reading: repaint what changed outright, retarget what eases, and draw.
  useEffect(() => {
    const now = performance.now();
    const mo = motion.current;
    dials.forEach((d, i) => {
      const f = faces[i];
      const k = faceKey(d);
      if (f.key !== k) {
        f.key = k;
        paintFace(f.c, d);
        f.t.needsUpdate = true;
      }
      mo.dials[i] = d.pct === null ? null : retarget(mo.dials[i], d.pct, now, 0, reduced);
    });
    paintTracks(strip, bars.length, bars.some((b) => b.pct === null));
    if (mo.cores.length !== bars.length) mo.cores = bars.map(() => null);
    bars.forEach((b, i) => {
      mo.cores[i] = b.pct === null ? null : retarget(mo.cores[i], b.pct, now, 0, reduced);
    });
    invalidate();
  }, [dials, bars, faces, strip, reduced, invalidate]);

  const cells = useMemo(() => coreCells(bars.length), [bars.length]);
  useFrame(() => {
    const now = performance.now();
    const mo = motion.current;
    let moving = false;
    mo.dials.forEach((e, i) => {
      const v = e ? easedAt(e, now) : null;
      if (e && easing(e, now)) moving = true;
      const needle = needles.current[i];
      if (needle) {
        needle.visible = v !== null;
        if (v !== null) needle.rotation.z = -angleOf(v);
      }
      const n = nums[i];
      const text = numText(v);
      if (n.text !== text) {
        n.text = text;
        paintNumber(n, text);
      }
    });
    const m = fills.current;
    if (!m) return;
    const iw = STRIP.w - 2 * STRIP_PAD * SK;
    const ih = STRIP.h - 2 * STRIP_PAD * SK;
    let n = 0;
    mo.cores.forEach((e, i) => {
      const cell = cells[i];
      if (!e || !cell) return;
      if (easing(e, now)) moving = true;
      const v = easedAt(e, now);
      const x = -STRIP.w / 2 + STRIP_PAD * SK + (cell.x + cell.w / 2) * iw;
      const y = STRIP.h / 2 - STRIP_PAD * SK - (cell.y + cell.h) * ih;
      tmp.m.makeScale(cell.w * iw, Math.max(1e-4, (cell.h * ih * v) / 100), 1).setPosition(x, y, 0);
      m.setMatrixAt(n, tmp.m);
      m.setColorAt(n, tmp.c.set(LEVEL_COLORS[cpuLevel(v)]));
      n++;
    });
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    if (moving) want(30);
  });

  const x = BOARD.w / 2 + 0.4 + GAUGE_COLUMN_W / 2;
  return (
    <group position={[x, 0, 0]}>
      <mesh geometry={panelGeo} position={[0, 0, -0.25]} castShadow receiveShadow>
        <meshStandardMaterial color="#cbd5e1" metalness={0.5} roughness={0.35} />
      </mesh>
      {faces.map((f, i) => (
        <group key={i} position={[0, DIAL_Y[i], 0]}>
          <mesh geometry={faceGeo} position={[0, 0, -0.02]}>
            <meshBasicMaterial map={f.t} />
          </mesh>
          <mesh geometry={numGeo} position={[0, -96 * K, -0.016]}>
            <meshBasicMaterial map={nums[i].t} transparent depthWrite={false} />
          </mesh>
          <mesh
            ref={(n) => {
              needles.current[i] = n;
            }}
            geometry={needleGeo}
            position={[0, 0, -0.012]}
            visible={false}
          >
            <meshBasicMaterial color="#f8fafc" />
          </mesh>
          <mesh geometry={hubGeo} position={[0, 0, -0.008]}>
            <meshBasicMaterial color="#e2e8f0" />
          </mesh>
          <mesh geometry={bezelGeo}>
            <meshStandardMaterial color="#94a3b8" metalness={0.7} roughness={0.25} />
          </mesh>
        </group>
      ))}
      <group position={[0, STRIP_Y, 0]}>
        <mesh geometry={stripGeo} position={[0, 0, 0.01]}>
          <meshBasicMaterial map={strip.t} />
        </mesh>
        <instancedMesh key={bars.length} ref={fills} args={[fillGeo, undefined, Math.max(1, bars.length)]} position={[0, 0, 0.015]} frustumCulled={false}>
          <meshBasicMaterial />
        </instancedMesh>
        <mesh geometry={stripBezelGeo} position={[0, 0, -0.06]}>
          <meshStandardMaterial color="#94a3b8" metalness={0.7} roughness={0.25} />
        </mesh>
      </group>
    </group>
  );
}
