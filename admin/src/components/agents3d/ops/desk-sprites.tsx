"use client";

import { deskParts, L, local, pts } from "./desks";
import { facing, figureBones, figureFaces, type Face, type V3 } from "./figure";
import type { P2 } from "./iso";
import type { OpsAct, OpsAgent, OpsLink } from "./model";

/**
 * An agent at its desk in the Ops view (T198), in the map's isometric style: the desk and its computer, the monitor's
 * frame in the agent's colour, the agent seated before it facing the codebases (seen from behind, the screen over its
 * shoulder), its name under it. The Table's poses, small: typing (arms on the desk, the screen's lines coming), reading,
 * running (a prompt), thinking (a bubble), waiting ("?" or "!"), idle (leaning back, faded) and napping (head on the
 * desk, "z", the screen off). Still but for typing and reading: a few blinks of the screen's lines when a new tool call
 * comes (CSS, finite, none under reduced motion), then nothing moves.
 */

const SKIN = "#f1c9a5", HAIR = "#3b2a20", SHOE = "#1f2937", INK = "#0b0f17";

const shade = (hex: string, k: number) => {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c * k)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
};
/** a face's colour: what its bone is made of, lit as the blocks are; the head's hair but where the face or an ear shows */
function faceFill(f: Face, color: string, faceOut: boolean) {
  const [base, k] = f.bone.stuff === "shirt" ? [color, 1] : f.bone.stuff === "pants" ? [color, 0.55] : f.bone.stuff === "skin" ? [SKIN, 1] : f.bone.stuff === "shoe" ? [SHOE, 1] : [HAIR, 1];
  // (the head's side towards +x: the cheek and ear; towards +z: the face when turned to the viewer, else the back of the head)
  const skin = f.bone.name === "head" && f.normal.h < 0.7 && (Math.abs(f.normal.x) > Math.abs(f.normal.z) || faceOut);
  return shade(skin ? SKIN : base, k * f.shade);
}

/** a screen log line's colour, by action (T204g): an edit or write orange, a read green, a command light green, else grey */
const ACT_COLORS: Record<OpsAct["kind"], string> = { edit: "#f59e0b", read: "#22c55e", bash: "#d9f99d", other: "#94a3b8" };
/** a screen log line's spacing (desk units) */
const ROW = 0.3;
/** a line's length (desk units, of the screen's 2): by its size on a log scale, like text of that length; a read or
 * other tool (no size) a middling length that varies with when it came */
export function actWidth(x: OpsAct): number {
  if (x.len > 0) return 0.35 + 1.5 * Math.min(1, Math.log10(1 + x.len) / 4);
  return 0.5 + (((x.ms / 1000) * 2654435761) % 997) / 997 * 0.6;
}

/** the curves' colours, by kind (T201, the user's): editing orange, reading green, claimed red; the legend's too */
export const KIND_COLORS = { edit: "#f59e0b", read: "#22c55e", claim: "#ef4444" } as const;
/** a curve's bright core: its colour, lighter (so the glow reads as that colour, not white) */
const CORE = { edit: "#fde68a", read: "#86efac", claim: "#fecaca" } as const;

/**
 * the keyframes for the screens' scroll, a curve's pulse, the typing hands, the packages' ride and the desks' moves
 * (once per map); none under reduced motion, nor with Low power on (T162: `data-low-power` on the view)
 */
export function DeskStyles() {
  return (
    <style>{`
      @keyframes ops-tap { 0% { transform: translateY(0) } 100% { transform: translateY(var(--tap, 1.5px)) } }
      .ops-tap-l, .ops-tap-r { animation: ops-tap .11s ease-in-out infinite alternate; }
      .ops-tap-r { animation-delay: -.11s; }
      @keyframes ops-pulse { from { stroke-dashoffset: 14 } to { stroke-dashoffset: -100 } }
      .ops-pulse { stroke-dasharray: 14 100; stroke-dashoffset: 14; animation: ops-pulse .9s ease-out 1 forwards; }
      .ops-pkg, .ops-seat { transition: transform .9s cubic-bezier(.2,.7,.3,1); }
      .ops-desk :is(polygon, ellipse, circle, line, rect, path) { vector-effect: non-scaling-stroke; }
      @keyframes ops-scroll { from { transform: translateY(var(--line, 3px)) } to { transform: none } }
      .ops-scroll { animation: ops-scroll .28s ease-out 1; }
      @media (prefers-reduced-motion: reduce) { .ops-pulse, .ops-tap-l, .ops-tap-r, .ops-scroll { animation: none } .ops-pkg, .ops-seat { transition: none } }
      [data-low-power] :is(.ops-pulse, .ops-tap-l, .ops-tap-r, .ops-scroll) { animation: none }
      [data-low-power] :is(.ops-pkg, .ops-seat) { transition: none }
    `}</style>
  );
}

/**
 * The glowing curves from agents' computers to the files they work on (T201): an arc rising from the monitor and
 * landing on the file's top, in the kind's colour, its glow three strokes (wide and faint, medium, a thin bright
 * core; no blur filter), a dot on the file, a thin ring of the agent's colour where it starts. Reads thinner; claims
 * dashed (every layer, the dashes scaled with the zoom, `u`, so they stay dashes); a touch fades over a minute and a
 * half (`fade`, on the model's 10 s steps); a new edit sends a pulse along it once.
 */
export function Curve({ l, from, to, color, dim, u }: { l: OpsLink; from: P2; to: P2; color: string; dim: boolean; u: number }) {
  const c = KIND_COLORS[l.kind], read = l.kind === "read";
  const k = Math.min(2.5, Math.max(0.6, u)), dash = l.kind === "claim" ? `${(6 * k).toFixed(1)} ${(4 * k).toFixed(1)}` : undefined;
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  const mx = (from.x + to.x) / 2, my = Math.min(from.y, to.y) - Math.max(24, d * 0.28);
  const path = `M${from.x.toFixed(1)},${from.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${to.x.toFixed(1)},${to.y.toFixed(1)}`;
  const o = (dim ? 0.3 : 1) * (0.25 + 0.75 * l.fade);
  return (
    <g className="pointer-events-none" opacity={o} fill="none" strokeLinecap={dash ? "butt" : "round"} strokeDasharray={dash}>
      <path d={path} stroke={c} strokeOpacity={0.12} strokeWidth={read ? 5 : 8} />
      <path d={path} stroke={c} strokeOpacity={0.35} strokeWidth={read ? 2.2 : 3.6} />
      <path d={path} stroke={CORE[l.kind]} strokeOpacity={read ? 0.85 : 0.95} strokeWidth={read ? 0.9 : 1.3} />
      {l.kind === "edit" && l.fade > 0.85 && <path key={l.ms} d={path} pathLength={100} className="ops-pulse" stroke="#ffffff" strokeWidth={2.4} />}
      <circle cx={to.x} cy={to.y} r={read ? 2 : 2.8} fill={c} stroke="#fff" strokeOpacity={0.8} strokeWidth={0.8} strokeDasharray="none" />
      <circle cx={from.x} cy={from.y} r={3} fill={c} stroke={color} strokeWidth={1.6} strokeDasharray="none" />
    </g>
  );
}

/**
 * the desk, the computer and the seated agent, drawn round its seat (the origin; the caller's group puts it on the map
 * and glides it when it moves, T204c) at scale `u` (the caller's units a desk unit's L pixels at full size)
 */
export function Desk({ a, u, selected, onClick }: { a: OpsAgent; u: number; selected: boolean; onClick: () => void }) {
  const d = deskParts(u);
  const busy = a.doing === "type" || a.doing === "read" || a.doing === "run" || a.doing === "think";
  const off = a.doing === "nap", idle = a.doing === "idle" || off;
  const screen = off ? "#0f141c" : a.doing === "run" ? "#0b1410" : a.doing === "read" ? "#123448" : busy ? "#1d2a3f" : "#151b26";
  // (the screen's log, T204g: a bar a line for each of its last actions, newest at the bottom, on the screen's face)
  const acts = a.acts ?? [];
  const barFrom = (row: number, from: number, w: number) => {
    const h = 3.35 + row * ROW, x0 = -1.0 + from, x1 = Math.min(0.95, -1.0 + w);
    return pts([local(x0, -3.0, h + 0.07, u), local(x1, -3.0, h + 0.07, u), local(x1, -3.0, h - 0.07, u), local(x0, -3.0, h - 0.07, u)]);
  };
  // (a bash line: a bright prompt, then the command)
  const bar = (row: number, w: number) => barFrom(row, 0, w);
  // (the agent: boxes along its bones, back to front, in the pose of what it does (figure.ts); the head's middle top
  // for the bubbles and badges)
  // (editing or running a command, T204d: the typing pose, the hands tapping the keys for as long as the step goes on
  // (busy), alternating, about 5 taps a second; CSS, which a hidden tab doesn't run; still under reduced motion)
  const pose = a.doing === "run" ? "type" : a.doing, tapping = pose === "type" && a.busy;
  const faces = figureFaces(pose), faceOut = facing(pose) > 0;
  const headBone = figureBones(pose).find((b) => b.name === "head")!;
  const P = (p: V3) => local(p.x, p.z, p.h, u);
  const head = P({ x: headBone.b.x, h: headBone.b.h - 0.2, z: headBone.b.z });
  const S = (v: number) => v * u * 1.45;
  return (
    <g className="ops-desk pointer-events-auto cursor-pointer" opacity={idle ? 0.6 : 1}
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
      {!off && acts.length > 0 && (
        // (keyed on the newest action: a new one scrolls the log up a line, once; dimmer while idle or waiting)
        <g key={acts[acts.length - 1].ms} className="ops-scroll" opacity={idle || a.doing === "wait" ? 0.45 : 0.95}
          style={{ "--line": `${(ROW * L * u).toFixed(2)}px` } as React.CSSProperties}>
          {acts.map((x, i) => {
            const row = acts.length - 1 - i;
            return (
              <g key={`${x.ms}${i}`}>
                {x.kind === "bash" && <polygon points={bar(row, 0.14)} fill="#4ade80" />}
                <polygon points={x.kind === "bash" ? barFrom(row, 0.22, actWidth(x)) : bar(row, actWidth(x))} fill={ACT_COLORS[x.kind]} />
              </g>
            );
          })}
        </g>
      )}
      {/* the stool */}
      <polygon points={pts([local(-0.8, -0.4, 1.3, u), local(0.8, -0.4, 1.3, u), local(0.8, 1.0, 1.3, u), local(-0.8, 1.0, 1.3, u)])} fill="#1f2633" stroke={INK} strokeWidth={0.6} />
      {/* the mouse, by the keyboard */}
      <polygon points={pts([local(1.05, -2.05, 2.62, u), local(1.45, -2.05, 2.62, u), local(1.45, -1.75, 2.62, u), local(1.05, -1.75, 2.62, u)])} fill="#1f2633" stroke={INK} strokeWidth={0.5} />
      {/* the agent, in isometric boxes (T202): back to front; typing, the hands tap while the step goes on (T204d) */}
      {faces.map((f, i) => {
        const hand = tapping && f.bone.name.startsWith("hand") ? (f.bone.name.endsWith("-l") ? "ops-tap-l" : "ops-tap-r") : undefined;
        return (
          <polygon key={`${f.bone.name}${i}`} points={pts(f.pts.map(P))} fill={faceFill(f, a.color, faceOut)} stroke={INK} strokeWidth={0.5} strokeLinejoin="round"
            className={hand} style={hand ? ({ "--tap": `${(1.3 * u).toFixed(2)}px` } as React.CSSProperties) : undefined} />
        );
      })}
      {faceOut && (() => {
        // (turned to the viewer: eyes on the face towards +z)
        const e = (dx: number) => P({ x: headBone.b.x + dx, h: headBone.b.h - 0.45, z: headBone.b.z + 0.56 });
        return <g fill={INK}><circle cx={e(-0.22).x} cy={e(-0.22).y} r={Math.max(0.8, 0.9 * u)} /><circle cx={e(0.22).x} cy={e(0.22).y} r={Math.max(0.8, 0.9 * u)} /></g>;
      })()}
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
    </g>
  );
}

/** an agent's name under its desk, round the seat as Desk is; `k`: screen pixels a unit there (the text kept 9–13 px) */
export function DeskName({ a, u, k, onClick }: { a: OpsAgent; u: number; k: number; onClick: () => void }) {
  return (
    <text y={14 * u * 1.45} textAnchor="middle" fill="#fff" fontSize={Math.min(13, Math.max(9, 11 * u * k)) / k} fontWeight={500}
      className="pointer-events-auto cursor-pointer" style={{ paintOrder: "stroke", stroke: INK, strokeWidth: 3 / k }} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      {a.name}
    </text>
  );
}
