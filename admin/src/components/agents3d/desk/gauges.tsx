"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import { BASE_PATH } from "@/lib/config";

import { type Dial, dialKey, dialsFor, LEVEL_COLORS, type StatsReading } from "./gauge-levels";
import { BOARD } from "./world";

/** How often the dials read /api/stats (paused while the tab is hidden). */
const POLL_MS = 5000;
/** A reading older than this (the stats daemon stopped) shows as no data. */
const STALE_MS = 60_000;
/** Dial radius and the gap between dials (world units). */
const DIAL = { r: 1.9, gap: 0.5 };
/** The column of dials on the whiteboard's right edge (world units wide). */
export const GAUGE_COLUMN_W = 2 * DIAL.r + 0.7;
const PX = 512;

/**
 * The dials' readings: /api/stats every POLL_MS while the tab is visible. The
 * state changes only when what a dial shows changes, so nothing re-renders in between.
 */
function useServerDials(): Dial[] {
  const [dials, setDials] = useState(() => dialsFor(null));
  useEffect(() => {
    let active = true;
    let id: ReturnType<typeof setInterval> | undefined;
    const show = (next: Dial[]) => setDials((prev) => (prev.map(dialKey).join("~") === next.map(dialKey).join("~") ? prev : next));
    const load = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/stats`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const s = (await res.json()) as StatsReading & { ts?: number };
        if (active) show(dialsFor(s.ts && Date.now() - s.ts > STALE_MS ? null : s));
      } catch {
        if (active) show(dialsFor(null));
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
  return dials;
}

/** The scale runs 270°, from bottom left (0) over the top to bottom right (100). */
const angleOf = (pct: number) => ((135 + (pct / 100) * 270) * Math.PI) / 180;

function paintDial(c: HTMLCanvasElement, d: Dial) {
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
  // Label, value and what's free, in the gap at the bottom.
  g.textAlign = "center";
  g.fillStyle = "#94a3b8";
  g.font = "bold 44px ui-sans-serif, system-ui, sans-serif";
  g.fillText(d.label, m, m - 62);
  g.fillStyle = "#f8fafc";
  g.font = "bold 88px ui-sans-serif, system-ui, sans-serif";
  g.fillText(d.value, m, m + 128);
  if (d.sub) {
    g.fillStyle = "#cbd5e1";
    g.font = "32px ui-sans-serif, system-ui, sans-serif";
    g.fillText(d.sub, m, m + 178);
  }
  // The needle and its hub.
  if (d.pct !== null) {
    const a = angleOf(d.pct);
    g.strokeStyle = "#f8fafc";
    g.lineWidth = 10;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(m - Math.cos(a) * 24, m - Math.sin(a) * 24);
    g.lineTo(m + Math.cos(a) * (m - 80), m + Math.sin(a) * (m - 80));
    g.stroke();
    g.lineCap = "butt";
  }
  g.fillStyle = "#e2e8f0";
  g.beginPath();
  g.arc(m, m, 18, 0, Math.PI * 2);
  g.fill();
}

const faceGeo = new THREE.CircleGeometry(DIAL.r, 64);
const bezelGeo = new THREE.TorusGeometry(DIAL.r, 0.12, 12, 64);
const panelGeo = new RoundedBoxGeometry(GAUGE_COLUMN_W, BOARD.h + 0.8, 0.4, 3, 0.15);

/**
 * Server CPU, memory and disk as three round dials in a column on the
 * whiteboard's right edge (whiteboard-local coordinates). No per-frame work:
 * a dial's texture is repainted only when its reading changes, then one
 * frame is requested (invalidate), which also suits an on-demand frameloop.
 */
export function ServerGauges() {
  const dials = useServerDials();
  const invalidate = useThree((s) => s.invalidate);
  const faces = useMemo(
    () =>
      [0, 1, 2].map(() => {
        const c = document.createElement("canvas");
        c.width = c.height = PX;
        const t = new THREE.CanvasTexture(c);
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        return { c, t, key: "" };
      }),
    [],
  );
  useEffect(() => () => faces.forEach((f) => f.t.dispose()), [faces]);
  useEffect(() => {
    let changed = false;
    dials.forEach((d, i) => {
      const f = faces[i];
      const k = dialKey(d);
      if (!f || f.key === k) return;
      f.key = k;
      paintDial(f.c, d);
      f.t.needsUpdate = true;
      changed = true;
    });
    if (changed) invalidate();
  }, [dials, faces, invalidate]);

  const x = BOARD.w / 2 + 0.4 + GAUGE_COLUMN_W / 2;
  return (
    <group position={[x, 0, 0]}>
      <mesh geometry={panelGeo} position={[0, 0, -0.25]} castShadow receiveShadow>
        <meshStandardMaterial color="#cbd5e1" metalness={0.5} roughness={0.35} />
      </mesh>
      {faces.map((f, i) => (
        <group key={i} position={[0, (1 - i) * (2 * DIAL.r + DIAL.gap), 0]}>
          <mesh geometry={faceGeo} position={[0, 0, -0.02]}>
            <meshBasicMaterial map={f.t} />
          </mesh>
          <mesh geometry={bezelGeo}>
            <meshStandardMaterial color="#94a3b8" metalness={0.7} roughness={0.25} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
