"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import type { TLAgent } from "@/lib/agents3d-timeline";
import type { BrowserSession } from "@/lib/browsers";

import { OverlayLabel } from "../overlay-label";
import { type BrowserLook, browserLook, lookKey, MAX_UNOWNED, seatBrowsers } from "./browser-look";
import { LEVEL_COLORS } from "./gauge-levels";
import { BROWSER, browserAt, seatAt, UNOWNED_BROWSERS } from "./world";

const PX = { w: 384, h: 256 };
/** Unowned windows cascade like stacked windows: each one up and back from the one before. */
const CASCADE = { y: 0.35, z: -0.3, x: 0.25 };
const UNOWNED_COLOR = "#64748b";

const frameGeo = new RoundedBoxGeometry(BROWSER.w + 0.14, BROWSER.h + 0.14, 0.08, 2, 0.05);
const screenGeo = new THREE.PlaneGeometry(BROWSER.w, BROWSER.h);
const footGeo = new THREE.BoxGeometry(0.9, 0.08, 0.6);
const frameMat = new THREE.MeshStandardMaterial({ color: "#1f2937", metalness: 0.4, roughness: 0.4 });

/** Cuts `text` with an ellipsis to fit `max` pixels in the current font. */
function fit(g: CanvasRenderingContext2D, text: string, max: number) {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

/** A browser window's look: a title bar (three dots, the session) in the owner's colour, the address bar (a globe, the host), the page's title, and its CPU as a bar. */
function windowTexture(l: BrowserLook, color: string) {
  const c = document.createElement("canvas");
  c.width = PX.w;
  c.height = PX.h;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f8fafc";
  g.beginPath();
  g.roundRect(0, 0, PX.w, PX.h, 16);
  g.fill();
  // Title bar.
  g.fillStyle = color;
  g.beginPath();
  g.roundRect(0, 0, PX.w, 50, [16, 16, 0, 0]);
  g.fill();
  ["#ef4444", "#f59e0b", "#22c55e"].forEach((d, i) => {
    g.fillStyle = d;
    g.beginPath();
    g.arc(26 + i * 24, 25, 8, 0, Math.PI * 2);
    g.fill();
  });
  g.fillStyle = "#ffffff";
  g.font = "bold 24px ui-sans-serif, system-ui, sans-serif";
  g.textBaseline = "middle";
  g.fillText(fit(g, l.more ? `${l.bar} +${l.more}` : l.bar, PX.w - 110), 98, 26);
  // Address bar: a globe and the host.
  g.fillStyle = "#e2e8f0";
  g.beginPath();
  g.roundRect(14, 62, PX.w - 28, 48, 24);
  g.fill();
  g.strokeStyle = "#475569";
  g.lineWidth = 3;
  g.beginPath();
  g.arc(40, 86, 12, 0, Math.PI * 2);
  g.moveTo(28, 86);
  g.lineTo(52, 86);
  g.ellipse(40, 86, 5, 12, 0, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = "#0f172a";
  g.font = "bold 30px ui-sans-serif, system-ui, sans-serif";
  g.fillText(fit(g, l.host, PX.w - 100), 62, 87);
  // The page's title.
  g.fillStyle = "#334155";
  g.font = "24px ui-sans-serif, system-ui, sans-serif";
  g.fillText(fit(g, l.title, PX.w - 32), 16, 140);
  // CPU: a bar along the bottom, coloured by level, with its value.
  g.fillStyle = "#cbd5e1";
  g.fillRect(16, 196, PX.w - 32, 40);
  g.fillStyle = LEVEL_COLORS[l.level];
  g.fillRect(16, 196, (PX.w - 32) * l.cpuFill, 40);
  g.fillStyle = "#0f172a";
  g.font = "bold 24px ui-sans-serif, system-ui, sans-serif";
  g.fillText(l.cpuText, 26, 217);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** One browser window standing on the table, with a label that reads from afar (`label`: its text, null for none). Repainted only when its look changes. */
function BrowserWindow({ look, label, color, x, y, z }: { look: BrowserLook; label: string | null; color: string; x: number; y: number; z: number }) {
  const key = lookKey(look, color);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tex = useMemo(() => windowTexture(look, color), [key]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <group position={[x, y, z]}>
      {y === 0 && <mesh geometry={footGeo} material={frameMat} position={[0, 0.04, -0.1]} />}
      <group position={[0, BROWSER.h / 2 + 0.2, 0]} rotation-x={-0.2}>
        <mesh geometry={frameGeo} material={frameMat} castShadow />
        <mesh geometry={screenGeo} position={[0, 0, 0.045]}>
          <meshBasicMaterial map={tex} toneMapped={false} />
        </mesh>
        {label !== null && (
          <OverlayLabel position={[0, BROWSER.h / 2 + 0.35, 0]} center zIndexRange={[15, 0]} style={{ pointerEvents: "none" }}>
            <div className="whitespace-nowrap rounded-full bg-black/70 px-1.5 py-0.5 text-[9px] text-white/85 shadow">
              <span className="mr-0.5">🌐</span>
              {label}
              <span className="ml-1 font-semibold" style={{ color: LEVEL_COLORS[look.level] }}>
                {look.cpuText}
              </span>
            </div>
          </OverlayLabel>
        )}
      </group>
    </group>
  );
}

/**
 * Who is using a browser (agent-browser with Chrome running): a little browser
 * window in front of the owner's laptop, showing its page's host and title and
 * the browser's CPU; sessions nobody at the table owns cascade in the front gap,
 * marked as unowned. Data from Alex's useBrowsers (every 5 s); no per-frame work.
 */
export function DeskBrowsers({ cast, sessions, colorOf }: { cast: TLAgent[]; sessions: BrowserSession[]; colorOf: (key: string) => string }) {
  const { byAgent, unowned } = useMemo(() => seatBrowsers(cast, sessions), [cast, sessions]);
  const shown = unowned.slice(0, MAX_UNOWNED);
  return (
    <group>
      {cast.map((a, i) => {
        const list = byAgent.get(a.key);
        if (!list) return null;
        const at = browserAt(seatAt(i, cast.length));
        const look = browserLook(list[0], true, list.length - 1);
        return <BrowserWindow key={a.key} look={look} label={look.host || "browser"} color={colorOf(a.key)} x={at.x} y={0} z={at.z} />;
      })}
      {shown.map((s, n) => (
        <BrowserWindow
          key={s.session}
          look={browserLook(s, false, n === shown.length - 1 ? unowned.length - shown.length : 0)}
          // One label for the cascade, on the front window: the cascade's own labels would sit on each other.
          label={n === 0 ? `unowned: ${s.session}${unowned.length > 1 ? ` +${unowned.length - 1}` : ""}` : null}
          color={UNOWNED_COLOR}
          x={UNOWNED_BROWSERS.x + n * CASCADE.x}
          y={n * CASCADE.y}
          z={UNOWNED_BROWSERS.z + n * CASCADE.z}
        />
      ))}
    </group>
  );
}
