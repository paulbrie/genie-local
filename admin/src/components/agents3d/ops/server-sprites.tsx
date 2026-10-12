"use client";

import { useEffect, useRef, useState } from "react";

import { BASE_PATH } from "@/lib/config";
import type { NetStats, PublicPort } from "@/lib/net-stats";

import { coreBarsFor, coreBarsKey, dialKey, dialsFor, EASE_MS, easedAt, LEVEL_COLORS, retarget, type CoreBar, type Dial, type Eased, type StatsReading } from "../desk/gauge-levels";
import { iso, type P2 } from "./iso";
import { TechMark } from "./tech-icons";
import { techOf } from "./tech";
import { blades, cablePoints, coreColor, formatRate, GATE, gates, HOST, meters, plateSizes, portLabel, pulseSeconds, readoutPx, type Gateway, type Rack } from "./server";

type Fit = { k: number; ox: number; oy: number };
const px = (f: Fit, p: P2): P2 => ({ x: f.ox + p.x * f.k, y: f.oy + p.y * f.k });
const pts = (ps: P2[]) => ps.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
const INK = "#0b0f17";
/** how often /api/stats is read (paused while the tab is hidden), and a reading older than this is no data */
const POLL_MS = 5000, STALE_MS = 60_000;

/** the readings: /api/stats every POLL_MS while the tab shows; each state changes only when what it shows does */
type Reading = StatsReading & { net?: NetStats | null; ports?: PublicPort[] | null };
const netKey = (n: NetStats | null) => (n ? `${n.iface}|${n.history.length ? n.history[n.history.length - 1].t : 0}` : "-");
const portsKey = (p: PublicPort[] | null) => (p ? p.map((x) => `${x.port}/${x.proto}:${x.service}`).join(",") : "-");
function useStats(): { dials: Dial[]; cores: CoreBar[]; net: NetStats | null; ports: PublicPort[] | null } {
  const [dials, setDials] = useState(() => dialsFor(null));
  const [cores, setCores] = useState(() => coreBarsFor(null));
  const [net, setNet] = useState<NetStats | null>(null);
  const [ports, setPorts] = useState<PublicPort[] | null>(null);
  useEffect(() => {
    let active = true, id: ReturnType<typeof setInterval> | undefined;
    const show = (s: Reading | null) => {
      const n = s?.net ?? null, p = s?.ports ?? null;
      setNet((was) => (netKey(was) === netKey(n) ? was : n));
      setPorts((was) => (portsKey(was) === portsKey(p) ? was : p));
      const d = dialsFor(s);
      setDials((p) => (p.map(dialKey).join("~") === d.map(dialKey).join("~") ? p : d));
      setCores((p) => { const b = coreBarsFor(s, p.length); return coreBarsKey(b) === coreBarsKey(p) ? p : b; });
    };
    const load = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/stats`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const s = (await res.json()) as Reading & { ts?: number };
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
  return { dials, cores, net, ports };
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
export function ServerRack({ rack, gateway, fit, onPorts }: { rack: Rack; gateway: Gateway; fit: Fit; /** how many public ports there are (the gateway is sized to them) */ onPorts?: (n: number) => void }) {
  const { dials, cores, net, ports } = useStats();
  const n = ports?.length ?? 0;
  useEffect(() => { if (ports) onPorts?.(n); }, [n, ports, onPorts]);
  const ref = useRef<SVGGElement>(null);
  const v = useEased([...dials.map((d) => d.pct), ...cores.map((c) => c.pct)], ref);
  const P = (x: number, z: number, h: number) => px(fit, iso(x, z, h));
  const r = rack;
  const front = [P(r.x0, r.z1, r.h), P(r.x1, r.z1, r.h), P(r.x1, r.z1, 0), P(r.x0, r.z1, 0)];
  const side = [P(r.x1, r.z0, r.h), P(r.x1, r.z1, r.h), P(r.x1, r.z1, 0), P(r.x1, r.z0, 0)];
  const top = [P(r.x0, r.z0, r.h), P(r.x1, r.z0, r.h), P(r.x1, r.z1, r.h), P(r.x0, r.z1, r.h)];
  const fs = readoutPx(r.wu, fit.k);
  const label = P((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, r.h + 1.4 * r.wu);
  return (
    <g ref={ref} className="pointer-events-none">
      {/* the gateway first: it stands behind the rack (T214) */}
      <GatewayView g={gateway} rack={r} fit={fit} net={net} ports={ports} fs={fs} />
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

const IN = "#22c55e", OUT = "#60a5fa";

/**
 * The gateway (T214): a low wall set apart behind the rack, a gate a public port lit (TCP green, UDP violet), its
 * number and service on a plate on the wall's face over the gate (drawn on that face, in iso); over its left end the
 * bandwidth in and out and their last minutes; a cable along the ground to the rack, a pulse along it at each new
 * reading, faster with more traffic (CSS, once a reading; none under reduced motion or Low power). Drawn before the
 * rack: it stands behind it.
 */
function GatewayView({ g, rack, fit, net, ports, fs }: { g: Gateway; rack: Rack; fit: Fit; net: NetStats | null; ports: PublicPort[] | null; fs: number }) {
  const list = ports ?? [], shown = gates(g, list.length), plate = plateSizes(g, fit.k);
  // (more ports than the wall has gates for, until it is laid out again: the rest counted)
  const P = (x: number, z: number, h: number) => px(fit, iso(x, z, h));
  const front = [P(g.x0, g.z1, g.h), P(g.x1, g.z1, g.h), P(g.x1, g.z1, 0), P(g.x0, g.z1, 0)];
  const side = [P(g.x1, g.z0, g.h), P(g.x1, g.z1, g.h), P(g.x1, g.z1, 0), P(g.x1, g.z0, 0)];
  const top = [P(g.x0, g.z0, g.h), P(g.x1, g.z0, g.h), P(g.x1, g.z1, g.h), P(g.x0, g.z1, g.h)];
  // (the cable: arching from the gateway's top over to the rack's, clear of its readouts)
  const path = `M${cablePoints(g, rack).map((p) => px(fit, p)).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L")}`;
  const rate = net ? net.inBps + net.outBps : 0, last = net?.history.length ? net.history[net.history.length - 1].t : 0;
  // (text on the wall's face: along it, x; up it, h; world units)
  const C = Math.cos(Math.PI / 6), k = fit.k;
  const onFace = (x: number, h: number) => { const p = P(x, g.z1, h); return `matrix(${(C * k).toFixed(4)} ${(0.5 * k).toFixed(4)} 0 ${k.toFixed(4)} ${p.x.toFixed(1)} ${p.y.toFixed(1)})`; };
  // (the bandwidth over the left end: rates, and the last minutes, each on its own scale, 90 × 18 px)
  const hist = net?.history ?? [], max = (key: "inBps" | "outBps") => Math.max(1, ...hist.map((h) => h[key]));
  const tl = P(g.x0, g.z1, g.h), at = { x: tl.x + 45, y: tl.y - 10 }, W = 90, H = 18;
  const line = (key: "inBps" | "outBps") => hist.map((h, i) => `${(at.x - W / 2 + (i / Math.max(1, hist.length - 1)) * W).toFixed(1)},${(at.y - (h[key] / max(key)) * H).toFixed(1)}`).join(" ");
  return (
    <g>
      <path d={path} fill="none" stroke="#334155" strokeWidth={3} strokeLinecap="round" />
      {net && last > 0 && <path key={last} d={path} pathLength={100} className="ops-pulse" fill="none" stroke={rate > 0 ? "#e2e8f0" : "#64748b"} strokeWidth={2.4} style={{ animationDuration: `${pulseSeconds(rate).toFixed(2)}s` }} />}
      <polygon points={pts(top)} fill="#2a3446" stroke={INK} strokeWidth={0.8} />
      <polygon points={pts(side)} fill="#141a26" stroke={INK} strokeWidth={0.8} />
      <polygon points={pts(front)} fill="#1a2130" stroke={INK} strokeWidth={0.8} />
      {shown.map((s, i) => {
        const p = list[i], lit = p.proto === "udp" ? "#a78bfa" : IN, tech = techOf(p);
        const service = p.service.length > 11 ? `${p.service.slice(0, 10)}…` : p.service;
        // (its box in front of the wall, T217: the gate's width, lit edges in the protocol's colour, the tech's mark on its front)
        const z0 = g.z1, z1 = g.z1 + GATE.boxD * g.wu, bh = GATE.boxH * g.wu, x0 = s.x0, x1 = s.x1;
        const front = [P(x0, z1, bh), P(x1, z1, bh), P(x1, z1, 0), P(x0, z1, 0)], side = [P(x1, z0, bh), P(x1, z1, bh), P(x1, z1, 0), P(x1, z0, 0)];
        const top = [P(x0, z0, bh), P(x1, z0, bh), P(x1, z1, bh), P(x0, z1, bh)];
        const mark = Math.min(x1 - x0, bh) * 0.72, markPx = mark * fit.k;
        const onFront = (x: number, h: number, size: number) => { const q = P(x, z1, h); return `matrix(${(C * k * size / 24).toFixed(4)} ${(0.5 * k * size / 24).toFixed(4)} 0 ${(k * size / 24).toFixed(4)} ${q.x.toFixed(1)} ${q.y.toFixed(1)})`; };
        return (
          <g key={`${p.port}/${p.proto}`}>
            <title>{`${portLabel(p)}${tech ? ` · ${tech.name}` : ""}${p.tech?.detail ? ` (${p.tech.detail})` : ""} · ${p.proto.toUpperCase()} · on ${p.addrs.join(", ")}${p.process ? ` · ${p.process}` : ""}`}</title>
            <polygon points={pts(top)} fill="#334155" stroke={lit} strokeWidth={1} />
            <polygon points={pts(side)} fill="#1e293b" stroke={lit} strokeWidth={1} />
            <polygon points={pts(front)} fill="#273244" stroke={lit} strokeWidth={1.2} />
            {/* (the mark from 10 px up; a box with no known tech stays plain: its number is on the plate over it) */}
            {tech && markPx >= 10 && <g transform={onFront(x0 + (x1 - x0 - mark) / 2, bh - (bh - mark) / 2, mark)}><TechMark icon={tech.icon} color={tech.color} /></g>}
            {/* (the plate over the gate: the number, and the service under it) */}
            <g transform={onFace(s.x0, g.h - 0.2 * g.wu)}>
              <rect x={0} y={0} width={s.x1 - s.x0} height={plate.h} rx={0.2 * g.wu} fill={INK} fillOpacity={0.85} />
              <text x={0.2 * g.wu} y={plate.num * 1.0} fill={lit} fontSize={plate.num} fontWeight={700} fontFamily="ui-monospace, monospace">{`${p.port}${p.proto === "udp" ? "/u" : ""}`}</text>
              {service && plate.service && <text x={0.2 * g.wu} y={plate.num * 1.15 + plate.service} fill="#e2e8f0" fontSize={plate.service} fontFamily="ui-monospace, monospace">{service}</text>}
            </g>
          </g>
        );
      })}
      {list.length > shown.length && (() => { const t = P(g.x1, g.z1, g.h * 0.5); return <text x={t.x + 6} y={t.y} fill="#94a3b8" fontSize={fs - 1}>+{list.length - shown.length} more</text>; })()}
      {ports === null && (() => { const t = P(g.x0 + 1.5 * g.wu, g.z1, g.h * 0.45); return <text x={t.x} y={t.y} fill="#64748b" fontSize={fs - 1}>ports: no data</text>; })()}
      {/* the bandwidth over the left end */}
      <rect x={at.x - W / 2 - 4} y={at.y - H - 3} width={W + 8} height={H + 6} rx={3} fill={INK} fillOpacity={0.75} />
      {hist.length > 1 && <polyline points={line("inBps")} fill="none" stroke={IN} strokeWidth={1.2} />}
      {hist.length > 1 && <polyline points={line("outBps")} fill="none" stroke={OUT} strokeWidth={1.2} />}
      <text x={at.x} y={at.y - H - 8} textAnchor="middle" fontSize={fs} fontFamily="ui-monospace, monospace" style={{ paintOrder: "stroke", stroke: INK, strokeWidth: 3 }}>
        <tspan fill={IN}>↓ {net ? formatRate(net.inBps) : "—"}</tspan><tspan fill={OUT}> ↑ {net ? formatRate(net.outBps) : "—"}</tspan>
      </text>
    </g>
  );
}
