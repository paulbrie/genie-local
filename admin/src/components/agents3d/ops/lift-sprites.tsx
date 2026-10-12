"use client";

import { useEffect, useMemo, useState } from "react";

import type { IsoMap, P2 } from "./iso";
import { footprint, liftedBlocks, liftsKey, NAME_MIN_PX, nameOf, type Lift } from "./lift";

type Fit = { k: number; ox: number; oy: number };
const pts = (ps: P2[], f: Fit) => ps.map((p) => `${(f.ox + p.x * f.k).toFixed(1)},${(f.oy + p.y * f.k).toFixed(1)}`).join(" ");
const INK = "#0b0f17";
const COLOR = { edit: "#f59e0b", read: "#22c55e" } as const;
const shade = (hex: string, k: number) => {
  const n = parseInt(hex.slice(1), 16), f = (c: number) => Math.max(0, Math.min(255, Math.round(c * k)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
};
/** a rise or a settle's length (ms), as the CSS below */
const GLIDE_MS = 900;

/**
 * The files being worked on, lifted (T216): over the cities, each file's block in its kind's colour (an edit orange,
 * a read green), its top lit, a soft shadow left on its spot. A file that starts being worked on rises from its spot,
 * one that ages out settles back, each once (CSS, 0.9 s; none under reduced motion or Low power); then nothing moves.
 * Drawn again only when the set changes.
 */
export function LiftedBlocks({ map, index, lifts, fit }: { map: IsoMap; index: Map<string, number>; lifts: Map<string, Lift>; fit: Fit }) {
  const key = liftsKey(lifts);
  // (those that aged out, kept while they settle back)
  const [leaving, setLeaving] = useState<Map<string, Lift>>(new Map());
  const [shown, setShown] = useState(lifts);
  useEffect(() => {
    const gone = new Map([...shown].filter(([k]) => !lifts.has(k)));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the set changed: what left settles, then goes
    setShown(lifts);
    if (!gone.size) return;
    setLeaving((was) => new Map([...was, ...gone]));
    const t = setTimeout(() => setLeaving((was) => new Map([...was].filter(([k]) => !gone.has(k) || lifts.has(k)))), GLIDE_MS);
    return () => clearTimeout(t);
    // (on a new set only)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const all = useMemo(() => {
    const merged = new Map([...leaving].filter(([k]) => !lifts.has(k)));
    for (const [k, v] of lifts) merged.set(k, v);
    return liftedBlocks(map, index, merged);
  }, [map, index, lifts, leaving]);
  return (
    <g className="pointer-events-none">
      <style>{`
        @keyframes ops-rise { from { transform: translateY(var(--rise)) } to { transform: none } }
        @keyframes ops-settle { from { transform: none } to { transform: translateY(var(--rise)) } }
        .ops-rise { animation: ops-rise .9s cubic-bezier(.2,.7,.3,1) 1; }
        .ops-settle { animation: ops-settle .9s cubic-bezier(.4,0,.6,1) 1 forwards; }
        @media (prefers-reduced-motion: reduce) { .ops-rise, .ops-settle { animation: none } }
        [data-low-power] :is(.ops-rise, .ops-settle) { animation: none }
      `}</style>
      {/* its spot, first: where it stood, emptied (its column on the city's canvas dimmed to the ground's tone) with a
          soft shadow under the block over it */}
      {all.map(({ key: k, ground }) => (
        <g key={`s${k}`}>
          {[ground.left, ground.right, ground.top].map((f, i) => <polygon key={i} points={pts(f, fit)} fill="#0f1522" fillOpacity={0.88} />)}
          <polygon points={pts(footprint(ground), fit)} fill="#000" fillOpacity={0.5} />
        </g>
      ))}
      {/* a tether from each lifted block down to its spot, dashed, in its kind's colour */}
      {all.map(({ key: k, lift, ground }) => {
        const foot = footprint(ground), mid = { x: foot.reduce((a, p) => a + p.x, 0) / 4, y: foot.reduce((a, p) => a + p.y, 0) / 4 };
        const a = { x: fit.ox + ground.peak.x * fit.k, y: fit.oy + ground.peak.y * fit.k }, b = { x: fit.ox + mid.x * fit.k, y: fit.oy + (mid.y - lift.h) * fit.k };
        return <line key={`t${k}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={COLOR[lift.kind]} strokeWidth={1.2} strokeDasharray="3 3" strokeOpacity={0.85} />;
      })}
      {all.map(({ key: k, lift, block }) => {
        const c = COLOR[lift.kind], going = leaving.has(k) && !lifts.has(k);
        // (its name over it, from a size up)
        const wide = (block.box.x1 - block.box.x0) * fit.k >= NAME_MIN_PX, name = nameOf(k);
        const top = lift.nameBelow ? { x: fit.ox + block.peak.x * fit.k, y: fit.oy + block.box.y1 * fit.k + 12 } : { x: fit.ox + block.peak.x * fit.k, y: fit.oy + block.box.y0 * fit.k - 4 };
        return (
          <g key={k} className={going ? "ops-settle" : "ops-rise"} style={{ "--rise": `${(lift.h * fit.k).toFixed(1)}px` } as React.CSSProperties}>
            {wide && <text x={top.x} y={top.y} textAnchor="middle" fill="#f8fafc" fontSize={10} fontFamily="ui-monospace, monospace" style={{ paintOrder: "stroke", stroke: INK, strokeWidth: 3 }}>{name}</text>}
            <polygon points={pts(block.left, fit)} fill={shade(c, 0.8)} stroke={INK} strokeWidth={0.6} />
            <polygon points={pts(block.right, fit)} fill={shade(c, 0.6)} stroke={INK} strokeWidth={0.6} />
            <polygon points={pts(block.top, fit)} fill={shade(c, 1.2)} stroke="#fff" strokeOpacity={0.7} strokeWidth={0.8} />
          </g>
        );
      })}
    </g>
  );
}
