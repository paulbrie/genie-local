"use client";

import { useEffect, useRef, useState } from "react";

import { BASE_PATH } from "@/lib/config";

import { coreBarsFor, coreBarsKey, dialKey, dialsFor, EASE_MS, easedAt, LEVEL_COLORS, retarget, type CoreBar, type Dial, type Eased, type StatsReading } from "../desk/gauge-levels";
import { iso, type P2 } from "./iso";
import { blades, coreColor, HOST, meters, type Rack } from "./server";

type Fit = { k: number; ox: number; oy: number };
const px = (f: Fit, p: P2): P2 => ({ x: f.ox + p.x * f.k, y: f.oy + p.y * f.k });
const pts = (ps: P2[]) => ps.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
const INK = "#0b0f17";
/** how often /api/stats is read (paused while the tab is hidden), and a reading older than this is no data */
const POLL_MS = 5000, STALE_MS = 60_000;

/** the readings: /api/stats every POLL_MS while the tab shows; each state changes only when what it shows does */
function useStats(): { dials: Dial[]; cores: CoreBar[] } {
  const [dials, setDials] = useState(() => dialsFor(null));
  const [cores, setCores] = useState(() => coreBarsFor(null));
  useEffect(() => {
    let active = true, id: ReturnType<typeof setInterval> | undefined;
    const show = (s: StatsReading | null) => {
      const d = dialsFor(s);
      setDials((p) => (p.map(dialKey).join("~") === d.map(dialKey).join("~") ? p : d));
      setCores((p) => { const b = coreBarsFor(s, p.length); return coreBarsKey(b) === coreBarsKey(p) ? p : b; });
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
    const start = () => { if (id !== undefined || document.hidden) return; void load(); id = setInterval(load, POLL_MS); };
    const stop = () => { clearInterval(id); id = undefined; };
    const vis = () => (document.hidden ? stop() : start());
    start();
    document.addEventListener("visibilitychange", vis);
    return () => { active = false; stop(); document.removeEventListener("visibilitychange", vis); };
  }, []);
  return { dials, cores };
}

/**
 * The numbers shown (the meters' fills, each core's load) easing to each new reading over EASE_MS (T101): frames are
 * asked for only while something eases, then nothing runs; reduced motion or Low power (`data-low-power` over it): jumps.
 */
function useEased(targets: (number | null)[], el: React.RefObject<SVGGElement | null>): (number | null)[] {
  const eased = useRef<(Eased | null)[]>([]);
  const [shown, setShown] = useState(targets);
  const key = targets.map((t) => (t === null ? "-" : t.toFixed(1))).join(",");
  useEffect(() => {
    const now = performance.now();
    const snap = window.matchMedia("(prefers-reduced-motion: reduce)").matches || !!el.current?.closest("[data-low-power]");
    eased.current = targets.map((t, i) => (t === null ? null : retarget(eased.current[i] ?? null, t, now, t, snap)));
    let raf = 0;
    const frame = () => {
      const t = performance.now();
      setShown(eased.current.map((e, i) => (e ? easedAt(e, t) : targets[i])));
      if (t - now < EASE_MS && !document.hidden) raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
    // (a new reading, by its key, starts the ease)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return shown;
}

/**
 * Our server (T209), beyond the commits' belts: a rack in the cities' style, a blade a core lit by its load (dark,
 * amber, red), its side's three meters (CPU, MEM used with what's free, DISK) in the Table gauges' colours, the host
 * over it. Drawn under the cities (its svg is under their canvas), so it never covers a block or a label.
 */
export function ServerRack({ rack, fit }: { rack: Rack; fit: Fit }) {
  const { dials, cores } = useStats();
  const ref = useRef<SVGGElement>(null);
  const v = useEased([...dials.map((d) => d.pct), ...cores.map((c) => c.pct)], ref);
  const P = (x: number, z: number, h: number) => px(fit, iso(x, z, h));
  const r = rack;
  const front = [P(r.x0, r.z1, r.h), P(r.x1, r.z1, r.h), P(r.x1, r.z1, 0), P(r.x0, r.z1, 0)];
  const side = [P(r.x1, r.z0, r.h), P(r.x1, r.z1, r.h), P(r.x1, r.z1, 0), P(r.x1, r.z0, 0)];
  const top = [P(r.x0, r.z0, r.h), P(r.x1, r.z0, r.h), P(r.x1, r.z1, r.h), P(r.x0, r.z1, r.h)];
  const fs = Math.max(8, Math.min(12, r.wu * fit.k * 0.9));
  const label = P((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, r.h + 1.4 * r.wu);
  return (
    <g ref={ref} className="pointer-events-none">
      <polygon points={pts(front)} fill="#1a2130" stroke={INK} strokeWidth={0.8} />
      <polygon points={pts(side)} fill="#141a26" stroke={INK} strokeWidth={0.8} />
      <polygon points={pts(top)} fill="#2a3446" stroke={INK} strokeWidth={0.8} />
      {/* a blade a core, lit by its load */}
      {blades(r, cores.length).map((b, i) => {
        const load = v[3 + i] ?? null;
        return <polygon key={i} points={pts([P(b.x0, r.z1, b.h1), P(b.x1, r.z1, b.h1), P(b.x1, r.z1, b.h0), P(b.x0, r.z1, b.h0)])} fill={coreColor(load)} stroke={INK} strokeWidth={0.4} />;
      })}
      {/* the side's meters: a track, its fill in the level's colour, the reading by it */}
      {meters(r).map((m, i) => {
        const d = dials[i], p = v[i] ?? 0, zf = m.z1 - (m.z1 - m.z0) * (p / 100);
        const at = P(r.x1, m.z0, (m.h0 + m.h1) / 2);
        const text = d.pct === null ? `${d.label} —` : d.label === "CPU" ? `CPU ${d.value}` : `${d.label} ${d.sub || d.value}`;
        return (
          <g key={d.label}>
            <polygon points={pts([P(r.x1, m.z0, m.h1), P(r.x1, m.z1, m.h1), P(r.x1, m.z1, m.h0), P(r.x1, m.z0, m.h0)])} fill="#0b0f17" />
            {d.pct !== null && <polygon points={pts([P(r.x1, zf, m.h1), P(r.x1, m.z1, m.h1), P(r.x1, m.z1, m.h0), P(r.x1, zf, m.h0)])} fill={LEVEL_COLORS[d.level]} />}
            <text x={at.x + 6} y={at.y + fs * 0.35} fill={d.level === "none" ? "#94a3b8" : LEVEL_COLORS[d.level]} fontSize={fs} fontFamily="ui-monospace, monospace"
              style={{ paintOrder: "stroke", stroke: INK, strokeWidth: 3 }}>{text}</text>
          </g>
        );
      })}
      <text x={label.x} y={label.y} textAnchor="middle" fill="#e2e8f0" fontSize={fs + 1} fontWeight={600} style={{ paintOrder: "stroke", stroke: INK, strokeWidth: 3 }}>{HOST}</text>
    </g>
  );
}
