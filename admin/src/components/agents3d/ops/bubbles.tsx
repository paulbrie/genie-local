"use client";

import type { P2 } from "./iso";
import type { OpsAgent } from "./model";

/**
 * The agents' bubbles in the Ops view (T205): above each head, its last steps in words (a tool call, the first line
 * of what it wrote, of what it thinks), the newest at the bottom, the older ones faded. A thought cloud (puffs up
 * from the head) when its newest step is thinking, a speech bubble with a tail otherwise. Laid out once per change
 * (`layoutBubbles`): neighbours never overlap (raised a step, then narrowed), none at all when the map is zoomed far
 * out (the figures too small to tell apart). Clicks are the map box's (its layers take no pointer events): it asks
 * `bubbleAt`.
 */

/** characters' width and a line's height at the bubbles' type size (10 px mono) */
const CW = 6.6, LH = 13, PAD = 6;
/** a bubble's tail above the head, and the head's top on the figure (desk units) */
export const HEAD_TOP = 6.2;
/** the figures this small (desk units → px) or less: no bubbles */
export const MIN_U = 0.42;
/** a bubble narrower than this can't be read: none then */
export const MIN_W = 110;

export type BubbleBox = { key: string; x: number; y: number; w: number; h: number; head: P2; lines: { text: string; fade: number; kind: string }[]; thinking: boolean };

const overlaps = (a: BubbleBox, b: BubbleBox) => a.x < b.x + b.w + 4 && b.x < a.x + a.w + 4 && a.y < b.y + b.h + 4 && b.y < a.y + a.h + 4;

/**
 * Where each bubble goes: centred over its head, raised by up to two bubble-heights to clear a neighbour, else
 * narrowed (its lines cut) until it clears. `heads`: each agent's head top on screen.
 */
export function layoutBubbles(agents: OpsAgent[], heads: Map<string, P2>, u: number, maxW = 280): BubbleBox[] {
  if (u < MIN_U) return [];
  const out: BubbleBox[] = [];
  const order = agents.filter((a) => a.bubble && heads.has(a.key)).sort((a, b) => heads.get(a.key)!.x - heads.get(b.key)!.x);
  // (as wide as three neighbours' spacing at most, so they fit on three levels)
  let gap = Infinity;
  for (let i = 1; i < order.length; i++) gap = Math.min(gap, Math.abs(heads.get(order[i].key)!.x - heads.get(order[i - 1].key)!.x));
  const cap = Math.min(maxW, gap * 3 - 8);
  // (the figures so close that a bubble couldn't hold a readable line: zoomed far out, none)
  if (cap < MIN_W) return [];
  for (const a of order) {
    const head = heads.get(a.key)!, lines = a.bubble!.lines;
    let w = Math.min(cap, Math.max(...lines.map((l) => l.text.length)) * CW + PAD * 2);
    const h = lines.length * LH + PAD;
    let placed: BubbleBox | null = null;
    for (let tries = 0; tries < 8 && !placed; tries++) {
      for (let level = 0; level < 3 && !placed; level++) {
        const b: BubbleBox = { key: a.key, x: head.x - w / 2, y: head.y - 14 - h - level * (h + 6), w, h, head, lines: [], thinking: a.bubble!.thinking };
        if (!out.some((o) => overlaps(o, b))) placed = b;
      }
      if (!placed) w = Math.max(MIN_W, w * 0.75);
    }
    if (!placed) continue;
    const chars = Math.max(6, Math.floor((placed.w - PAD * 2) / CW));
    placed.lines = lines.map((l) => ({ ...l, text: l.text.length > chars ? `${l.text.slice(0, chars - 1)}…` : l.text }));
    out.push(placed);
  }
  return out;
}

/** the bubble at screen point `p`, if any (the topmost: the last drawn) */
export function bubbleAt(boxes: BubbleBox[], p: P2): BubbleBox | null {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return b;
  }
  return null;
}

export function Bubbles({ boxes, color }: { boxes: BubbleBox[]; color: (key: string) => string }) {
  return (
    <g className="pointer-events-none" aria-label="What the agents are doing">
      {boxes.map((b) => {
        const c = color(b.key), bottom = b.y + b.h, cx = Math.min(Math.max(b.head.x, b.x + 10), b.x + b.w - 10);
        return (
          <g key={b.key}>
            {/* (the tail: puffs for a thought, a point for speech) */}
            {b.thinking ? (
              <>
                <circle cx={(cx + b.head.x) / 2} cy={(bottom + b.head.y) / 2 + 1} r={3} fill="#f8fafc" stroke={c} strokeWidth={1} />
                <circle cx={b.head.x} cy={b.head.y - 2} r={1.8} fill="#f8fafc" stroke={c} strokeWidth={1} />
              </>
            ) : (
              <path d={`M${cx - 5},${bottom - 1} L${b.head.x},${b.head.y - 2} L${cx + 5},${bottom - 1} Z`} fill="#f8fafc" stroke={c} strokeWidth={1} strokeLinejoin="round" />
            )}
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={b.thinking ? Math.min(12, b.h / 2) : 5} fill="#f8fafc" fillOpacity={0.96} stroke={c} strokeWidth={1.2} strokeDasharray={b.thinking ? "3 2" : undefined} />
            {/* (hide the tail's join under the bubble's edge) */}
            {!b.thinking && <rect x={cx - 4} y={bottom - 2} width={8} height={2} fill="#f8fafc" />}
            {b.lines.map((l, i) => (
              <text key={i} x={b.x + PAD} y={b.y + PAD / 2 + 10 + i * LH} opacity={l.fade} className={`font-mono text-[10px] ${l.kind === "think" ? "fill-slate-500 italic" : l.kind === "say" ? "fill-slate-900" : "fill-slate-700"}`}>
                {l.text}
              </text>
            ))}
          </g>
        );
      })}
    </g>
  );
}
