"use client";

import { deskParts, local, pts } from "./desks";
import type { P2 } from "./iso";
import type { OpsAgent, OpsLink } from "./model";

/**
 * An agent at its desk in the Ops view (T198), in the map's isometric style: the desk and its computer, the monitor's
 * frame in the agent's colour, the agent seated before it facing the codebases (seen from behind, the screen over its
 * shoulder), its name under it. The Table's poses, small: typing (arms on the desk, the screen's lines coming), reading,
 * running (a prompt), thinking (a bubble), waiting ("?" or "!"), idle (leaning back, faded) and napping (head on the
 * desk, "z", the screen off). Still but for typing and reading: a few blinks of the screen's lines when a new tool call
 * comes (CSS, finite, none under reduced motion), then nothing moves.
 */

const SKIN = "#f1c9a5", HAIR = "#3b2a20", INK = "#0b0f17";

/** the curves' colours, by kind (T201, the user's): editing orange, reading green, claimed red; the legend's too */
export const KIND_COLORS = { edit: "#f59e0b", read: "#22c55e", claim: "#ef4444" } as const;
/** a curve's bright core: its colour, lighter (so the glow reads as that colour, not white) */
const CORE = { edit: "#fde68a", read: "#86efac", claim: "#fecaca" } as const;

/** the keyframes for the screens' blinks, a curve's pulse and the packages' ride (once per map) */
export function DeskStyles() {
  return (
    <style>{`
      @keyframes ops-desk-line { 0% { opacity: .25 } 100% { opacity: 1 } }
      .ops-desk-lines rect { animation: ops-desk-line .3s ease-in-out 6 alternate both; }
      .ops-desk-lines rect:nth-child(2) { animation-delay: .1s }
      .ops-desk-lines rect:nth-child(3) { animation-delay: .2s }
      @keyframes ops-pulse { from { stroke-dashoffset: 14 } to { stroke-dashoffset: -100 } }
      .ops-pulse { stroke-dasharray: 14 100; stroke-dashoffset: 14; animation: ops-pulse .9s ease-out 1 forwards; }
      .ops-pkg { transition: transform .9s cubic-bezier(.2,.7,.3,1); }
      @media (prefers-reduced-motion: reduce) { .ops-desk-lines rect, .ops-pulse { animation: none } .ops-pkg { transition: none } }
    `}</style>
  );
}

/**
 * The glowing curves from agents' computers to the files they work on (T201): an arc rising from the monitor and
 * landing on the file's top, in the kind's colour, its glow three strokes (wide and faint, medium, a thin bright
 * core; no blur filter), a dot on the file, a thin ring of the agent's colour where it starts. Reads thinner; a
 * touch fades over a minute and a half (`fade`, on the model's 10 s steps); a new edit sends a pulse along it once.
 */
export function Curve({ l, from, to, color, dim }: { l: OpsLink; from: P2; to: P2; color: string; dim: boolean }) {
  const c = KIND_COLORS[l.kind], read = l.kind === "read";
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  const mx = (from.x + to.x) / 2, my = Math.min(from.y, to.y) - Math.max(24, d * 0.28);
  const path = `M${from.x.toFixed(1)},${from.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${to.x.toFixed(1)},${to.y.toFixed(1)}`;
  const o = (dim ? 0.3 : 1) * (0.25 + 0.75 * l.fade);
  return (
    <g className="pointer-events-none" opacity={o} fill="none" strokeLinecap="round">
      <path d={path} stroke={c} strokeOpacity={0.12} strokeWidth={read ? 5 : 8} />
      <path d={path} stroke={c} strokeOpacity={0.35} strokeWidth={read ? 2.2 : 3.6} />
      <path d={path} stroke={CORE[l.kind]} strokeOpacity={read ? 0.85 : 0.95} strokeWidth={read ? 0.9 : 1.3} />
      {l.kind === "edit" && l.fade > 0.85 && <path key={l.ms} d={path} pathLength={100} className="ops-pulse" stroke="#ffffff" strokeWidth={2.4} />}
      <circle cx={to.x} cy={to.y} r={read ? 2 : 2.8} fill={c} stroke="#fff" strokeOpacity={0.8} strokeWidth={0.8} />
      <circle cx={from.x} cy={from.y} r={3} fill={c} stroke={color} strokeWidth={1.6} />
    </g>
  );
}

/** the desk, the computer and the seated agent, drawn at its seat (`at`, px) at scale `u` */
export function Desk({ a, at, u, selected, onClick }: { a: OpsAgent; at: P2; u: number; selected: boolean; onClick: () => void }) {
  const d = deskParts(u);
  const busy = a.doing === "type" || a.doing === "read" || a.doing === "run" || a.doing === "think";
  const off = a.doing === "nap", idle = a.doing === "idle" || off;
  const screen = off ? "#0f141c" : a.doing === "run" ? "#0b1410" : a.doing === "read" ? "#123448" : busy ? "#1d2a3f" : "#151b26";
  const lineColor = a.doing === "read" ? KIND_COLORS.read : a.doing === "type" ? KIND_COLORS.edit : "#94a3b8";
  // (the screen's lines, along its face: three rows of code)
  const sx = (x: number, h: number) => local(x, -3.0, h, u);
  const line = (row: number, len: number) => {
    const a0 = sx(-0.9, 4.6 - row * 0.5), a1 = sx(-0.9 + len, 4.6 - row * 0.5);
    return { x: Math.min(a0.x, a1.x), y: Math.min(a0.y, a1.y), w: Math.abs(a1.x - a0.x), h: Math.max(1, 1.6 * u) };
  };
  // (the agent: leaning back when idle, head down on the desk when napping)
  // (the torso from the seat (h 1.3) to the shoulders (h 3.6), the head on them; napping, bent over onto the desk)
  const lean = idle && !off ? 0.5 : 0;
  const hip = local(0, 0.2, 1.3, u), shoulders = off ? local(0, -0.5, 3.0, u) : local(0, 0.2 + lean, 3.6, u);
  const head = off ? local(0, -1.7, 3.15, u) : local(0, 0.1 + lean * 1.3, 4.35, u);
  // (the figure's measures, px at full scale)
  const S = (v: number) => v * u * 1.45;
  return (
    <g transform={`translate(${at.x.toFixed(1)},${at.y.toFixed(1)})`} className="pointer-events-auto cursor-pointer" opacity={idle ? 0.6 : 1}
      onClick={(e) => { e.stopPropagation(); onClick(); }}>
      <title>{a.name}</title>
      {/* the shadow under the seat, the selection ring */}
      <ellipse cx={S(8)} cy={S(2)} rx={S(22)} ry={S(8)} fill="#000" opacity={0.35} />
      {selected && <ellipse cx={S(8)} cy={S(2)} rx={S(26)} ry={S(10)} fill="none" stroke="#fff" strokeWidth={1.5} />}
      {/* the desk: its far panel, the desktop, its near panel */}
      <polygon points={pts(d.legL.side)} fill="#1c2230" stroke={INK} strokeWidth={0.6} />
      <polygon points={pts(d.legL.front)} fill="#252c3b" stroke={INK} strokeWidth={0.6} />
      <polygon points={pts(d.legR.front)} fill="#252c3b" stroke={INK} strokeWidth={0.6} />
      <polygon points={pts(d.legR.side)} fill="#1c2230" stroke={INK} strokeWidth={0.6} />
      <polygon points={pts(d.top.front)} fill="#4a5568" stroke={INK} strokeWidth={0.6} />
      <polygon points={pts(d.top.side)} fill="#3b4557" stroke={INK} strokeWidth={0.6} />
      <polygon points={pts(d.top.top)} fill="#64748b" stroke={INK} strokeWidth={0.6} />
      {/* the computer: stand, monitor (the agent's colour), screen */}
      <polygon points={pts(d.stand.front)} fill="#1b2130" />
      <polygon points={pts(d.monitor.side)} fill={a.color} opacity={0.7} stroke={INK} strokeWidth={0.6} />
      <polygon points={pts(d.monitor.top)} fill={a.color} stroke={INK} strokeWidth={0.6} />
      <polygon points={pts(d.monitor.front)} fill={a.color} stroke={INK} strokeWidth={0.6} />
      <polygon points={pts(d.screen)} fill={screen} />
      {!off && !idle && a.doing !== "wait" && (
        // (keyed on the last tool call: a new one blinks the lines a few times, then they hold)
        <g key={a.lastTool ?? ""} className={a.doing === "type" || a.doing === "read" ? "ops-desk-lines" : undefined}>
          {(a.doing === "run" ? [[0, 0.5], [1, 1.4]] : [[0, 1.5], [1, 1.1], [2, 1.7]]).map(([r, len]) => {
            const b = line(r, len);
            return <rect key={r} x={b.x} y={b.y} width={b.w} height={b.h} fill={a.doing === "run" ? "#4ade80" : lineColor} opacity={0.9} />;
          })}
        </g>
      )}
      {/* the stool */}
      <polygon points={pts([local(-0.8, -0.4, 1.3, u), local(0.8, -0.4, 1.3, u), local(0.8, 1.0, 1.3, u), local(-0.8, 1.0, 1.3, u)])} fill="#1f2633" stroke={INK} strokeWidth={0.6} />
      {/* the agent, from behind: the torso in its colour (rounded shoulders), arms to the desk when typing, the back of its head */}
      {a.doing === "type" && (
        <g stroke={a.color} strokeWidth={S(2.4)} strokeLinecap="round">
          {[-1, 1].map((k) => { const to = local(k * 0.7, -1.6, 2.65, u); return <line key={k} x1={shoulders.x + k * S(4)} y1={shoulders.y + S(3)} x2={to.x} y2={to.y} />; })}
        </g>
      )}
      <path d={`M${hip.x - S(5.5)},${hip.y} L${shoulders.x - S(5.5)},${shoulders.y + S(3)} Q${shoulders.x - S(5.5)},${shoulders.y - S(1)} ${shoulders.x},${shoulders.y - S(1)} Q${shoulders.x + S(5.5)},${shoulders.y - S(1)} ${shoulders.x + S(5.5)},${shoulders.y + S(3)} L${hip.x + S(5.5)},${hip.y} Z`}
        fill={a.color} stroke={INK} strokeWidth={1} />
      {/* (seen from behind: the neck, then the back of the head, all hair but the ears) */}
      {!off && <rect x={head.x - S(1.8)} y={head.y + S(3)} width={S(3.6)} height={S(3)} fill={SKIN} />}
      <circle cx={head.x - S(4.4)} cy={head.y + S(0.6)} r={S(1.2)} fill={SKIN} />
      <circle cx={head.x + S(4.4)} cy={head.y + S(0.6)} r={S(1.2)} fill={SKIN} />
      <circle cx={head.x} cy={head.y} r={S(4.6)} fill={HAIR} stroke={INK} strokeWidth={1} />
      {a.doing === "think" && (
        <g fill="#e2e8f0" opacity={0.9}>
          <circle cx={head.x + S(6)} cy={head.y - S(6)} r={S(1.3)} />
          <circle cx={head.x + S(9)} cy={head.y - S(10)} r={S(1.8)} />
          <ellipse cx={head.x + S(15)} cy={head.y - S(16)} rx={S(6.5)} ry={S(4.2)} />
          <text x={head.x + S(15)} y={head.y - S(14.5)} textAnchor="middle" fill={INK} fontSize={S(8)} fontWeight={700}>…</text>
        </g>
      )}
      {a.doing === "wait" && (
        <g transform={`translate(${head.x + S(9)},${head.y - S(9)})`}>
          <circle r={S(6.5)} fill="#f59e0b" stroke={INK} strokeWidth={1} />
          <text y={S(3.5)} textAnchor="middle" fill="#000" fontSize={S(10)} fontWeight={700}>{a.waitFor === "permission" ? "!" : "?"}</text>
        </g>
      )}
      {off && <text x={head.x + S(6)} y={head.y - S(6)} fill="#cbd5e1" fontSize={S(9)}>z</text>}
      <text y={S(14)} textAnchor="middle" fill="#fff" fontSize={Math.min(13, Math.max(9, 11 * u))} fontWeight={500} style={{ paintOrder: "stroke", stroke: INK, strokeWidth: 3 }}>
        {a.name}
      </text>
    </g>
  );
}
