"use client";

import type { P2 } from "./iso";
import type { OpsAgent } from "./model";

/**
 * The agents' bubbles in the Ops view (T205, T205d): above each head, its last thoughts (the first line of each
 * thinking block), the newest at the bottom, the older ones a little fainter; near-black on a pale bubble, the admin's
 * sans at 12 px, each thought wrapped on up to two lines within MAX_W (cut past that; the whole thought on hover).
 * A thought cloud: dashed in the agent's colour, puffs rising from the head. Laid out once per change
 * (`layoutBubbles`): neighbours never overlap (raised a step, then narrowed and wrapped again), none when the map is
 * zoomed far out (the figures too close for a readable bubble). Clicks and hovers are the map box's (its layers take
 * no pointer events): it asks `bubbleAt`.
 */

/** a line's height at the bubbles' type size (12 px sans), the padding, the widest bubble */
const LH = 16, PAD = 9;
export const MAX_W = 280;
/** at most this many lines in a bubble, and per thought */
const MAX_LINES = 4, PER_THOUGHT = 2;
/** a bubble's tail above the head, and the head's top on the figure (desk units) */
export const HEAD_TOP = 6.2;
/** the figures this small (desk units → px; about 0.85 with the whole map in view) or less: zoomed far out, no bubbles */
export const MIN_U = 0.55;
/** a bubble narrower than this can't be read: none then */
export const MIN_W = 140;

/** a text's width in px at the bubbles' type (the page measures it; the tests use an estimate) */
export type Measure = (text: string) => number;
export const estimate: Measure = (t) => t.length * 6.4;

export type BubbleBox = {
  key: string; x: number; y: number; w: number; h: number; head: P2;
  /** the lines drawn (thoughts wrapped), each with its thought's fade */
  lines: { text: string; fade: number }[];
  /** the thoughts whole, for the hover card */
  full: string[];
  thinking: boolean;
};

const overlaps = (a: BubbleBox, b: BubbleBox) => a.x < b.x + b.w + 4 && b.x < a.x + a.w + 4 && a.y < b.y + b.h + 4 && b.y < a.y + a.h + 4;

/** `text` wrapped by words to `width` px on at most `max` lines, the last cut with "…" if it doesn't fit */
export function wrap(text: string, width: number, measure: Measure, max = PER_THOUGHT): string[] {
  const words = text.split(/\s+/).filter(Boolean), out: string[] = [];
  let line = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i], next = line ? `${line} ${w}` : w;
    if (measure(next) <= width) { line = next; continue; }
    if (line) out.push(line);
    line = w;
    if (out.length === max - 1) {
      // (the last line: the rest, cut to fit)
      let rest = words.slice(i).join(" ");
      if (measure(rest) > width) {
        while (rest.length > 1 && measure(`${rest}…`) > width) rest = rest.slice(0, -1);
        rest = `${rest.trimEnd()}…`;
      }
      out.push(rest);
      return out;
    }
  }
  if (line) {
    // (one word longer than the width: cut)
    while (line.length > 1 && measure(line) > width) line = line.slice(0, -2) + "…";
    out.push(line);
  }
  return out;
}

/** the thoughts wrapped to `width`, the newest kept first when they don't all fit in MAX_LINES */
function linesFor(thoughts: { text: string; fade: number }[], width: number, measure: Measure) {
  const out: { text: string; fade: number }[] = [];
  for (let i = thoughts.length - 1; i >= 0; i--) {
    const w = wrap(thoughts[i].text, width, measure);
    if (out.length + w.length > MAX_LINES && out.length) break;
    out.unshift(...w.slice(0, MAX_LINES - out.length).map((text) => ({ text, fade: thoughts[i].fade })));
  }
  return out;
}

/**
 * Where each bubble goes: centred over its head, raised by up to two bubble-heights to clear a neighbour, else
 * narrowed (wrapped again) until it clears. `heads`: each agent's head top on screen.
 */
export function layoutBubbles(agents: OpsAgent[], heads: Map<string, P2>, u: number, measure: Measure = estimate, maxW = MAX_W): BubbleBox[] {
  if (u < MIN_U) return [];
  const out: BubbleBox[] = [];
  const order = agents.filter((a) => a.bubble && heads.has(a.key)).sort((a, b) => heads.get(a.key)!.x - heads.get(b.key)!.x);
  for (const a of order) {
    const head = heads.get(a.key)!, thoughts = a.bubble!.lines;
    // (as wide as MAX_W, narrowed (wrapped again) only where a neighbour is in the way)
    let w = maxW, placed: BubbleBox | null = null;
    for (let tries = 0; tries < 6 && !placed; tries++) {
      const lines = linesFor(thoughts, w - PAD * 2, measure);
      // (no wider than its longest line needs)
      const bw = Math.min(w, Math.max(...lines.map((l) => measure(l.text))) + PAD * 2 + 2), h = lines.length * LH + PAD * 2 - 4;
      for (let level = 0; level < 3 && !placed; level++) {
        const b: BubbleBox = { key: a.key, x: head.x - bw / 2, y: head.y - 14 - h - level * (h + 6), w: bw, h, head, lines, full: thoughts.map((t) => t.text), thinking: a.bubble!.thinking };
        if (!out.some((o) => overlaps(o, b))) placed = b;
      }
      if (!placed) w = Math.max(MIN_W, w * 0.8);
    }
    if (placed) out.push(placed);
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

/** near-black on the pale bubble: about 17:1, and older thoughts kept at 0.75 or more of it (still well past AA) */
const INK = "#111827", PAPER = "#f8fafc";

/** a thought's three puffs from the head up to its cloud: where along the way (0 the head, 1 the cloud) and how big */
export const PUFFS = [
  { t: 0.15, r: 1.4 },
  { t: 0.45, r: 1.9 },
  { t: 0.78, r: 2.5 },
] as const;

/**
 * The puffs pulse in turn, head to cloud, as a typing indicator does (T205f): CSS only; paused while the tab is hidden
 * (`data-paused` on the bubbles' layer), still under Low power and reduced motion.
 */
function PuffStyles() {
  return (
    <style>{`
      @keyframes ops-puff { 0%, 60%, 100% { opacity: .45; transform: scale(1) } 30% { opacity: 1; transform: scale(1.3) } }
      .ops-puff { transform-box: fill-box; transform-origin: center; animation: ops-puff 1.2s ease-in-out infinite; }
      [data-paused] .ops-puff { animation-play-state: paused; }
      [data-low-power] .ops-puff { animation: none; }
      @media (prefers-reduced-motion: reduce) { .ops-puff { animation: none } }
    `}</style>
  );
}

export function Bubbles({ boxes, color }: { boxes: BubbleBox[]; color: (key: string) => string }) {
  return (
    <g className="pointer-events-none" aria-label="What the agents are thinking">
      <PuffStyles />
      {boxes.map((b) => {
        const c = color(b.key), bottom = b.y + b.h, cx = Math.min(Math.max(b.head.x, b.x + 12), b.x + b.w - 12);
        return (
          <g key={b.key}>
            {/* (the tail: puffs for a thought, a point for speech) */}
            {b.thinking ? (
              PUFFS.map((q, i) => (
                <circle key={i} className="ops-puff" style={{ animationDelay: `${i * 0.2}s` }} cx={b.head.x + (cx - b.head.x) * q.t} cy={b.head.y - 2 + (bottom - b.head.y + 2) * q.t} r={q.r} fill={PAPER} stroke={c} strokeWidth={1.1} />
              ))
            ) : (
              <path d={`M${cx - 6},${bottom - 1} L${b.head.x},${b.head.y - 2} L${cx + 6},${bottom - 1} Z`} fill={PAPER} stroke={c} strokeWidth={1.2} strokeLinejoin="round" />
            )}
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={b.thinking ? Math.min(14, b.h / 2) : 6} fill={PAPER} stroke={c} strokeWidth={1.5} strokeDasharray={b.thinking ? "4 2" : undefined} />
            {!b.thinking && <rect x={cx - 5} y={bottom - 2} width={10} height={2} fill={PAPER} />}
            {b.lines.map((l, i) => (
              <text key={i} x={b.x + PAD} y={b.y + PAD + 9 + i * LH} fill={INK} opacity={0.64 + 0.36 * l.fade} className="font-sans text-[12px]">
                {l.text}
              </text>
            ))}
          </g>
        );
      })}
    </g>
  );
}
