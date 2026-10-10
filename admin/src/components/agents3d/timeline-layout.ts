/**
 * The replay timeline's track layout: each agent's task clips go into stacked
 * lanes where they overlap in time, each lane TASK_LANE_H tall with its label
 * inside, and a busy band under them; an agent's row is as tall as its lanes
 * need. Pure, so it is tested; the canvas and the track headers both use it.
 */

/** A task lane's height (its label sits inside, vertically centred). */
export const TASK_LANE_H = 22;
export const LANE_GAP = 2;
/** Space above the first lane (message ticks sit on the row's top edge). */
export const ROW_PAD = 3;
/** The busy "waveform" band under the lanes. */
export const BUSY_H = 6;
const ROW_BOTTOM = 3;

/** A clip's time span; `e` null while it is still open (it reaches to now and beyond). */
export type Span = { s: number; e: number | null };

/**
 * Greedy lanes: in start order, each span takes the first lane whose last span
 * ended by its start. Returns each span's lane (in the input's order) and how
 * many lanes there are (at least 1). An open span keeps its lane to the end, so
 * the layout doesn't change as time passes.
 */
export function packLanes(spans: Span[]): { lane: number[]; lanes: number } {
  const order = spans.map((_, i) => i).sort((x, y) => spans[x].s - spans[y].s || x - y);
  const ends: number[] = [];
  const lane = new Array<number>(spans.length).fill(0);
  for (const i of order) {
    const e = spans[i].e ?? Infinity;
    let l = ends.findIndex((end) => end <= spans[i].s);
    if (l < 0) l = ends.push(e) - 1;
    else ends[l] = e;
    lane[i] = l;
  }
  return { lane, lanes: Math.max(1, ends.length) };
}

/** An agent row's height for `lanes` task lanes. */
export function rowHeight(lanes: number): number {
  const n = Math.max(1, lanes);
  return ROW_PAD + n * TASK_LANE_H + (n - 1) * LANE_GAP + 2 + BUSY_H + ROW_BOTTOM;
}

/** Top of lane `lane` in a row starting at `rowTop`. */
export const laneTop = (rowTop: number, lane: number) => rowTop + ROW_PAD + lane * (TASK_LANE_H + LANE_GAP);

/** Top of the busy band in a row. */
export const busyTop = (rowTop: number, rowH: number) => rowTop + rowH - ROW_BOTTOM - BUSY_H;

/** Each row's top, stacked from `top`. */
export function rowTops(heights: number[], top: number): number[] {
  const out: number[] = [];
  let y = top;
  for (const h of heights) {
    out.push(y);
    y += h;
  }
  return out;
}

/**
 * Text colour that reads on a bar of colour `hex` drawn at `alpha` over the
 * timeline's background: near-black on light bars (amber, green), white on dark
 * ones (blue, red, grey, and anything faint).
 */
export function labelInk(hex: string, alpha: number, bg = "#0b0f17"): string {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const [c, b] = [rgb(hex), rgb(bg)];
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = (v: number[]) => 0.2126 * lin(v[0]) + 0.7152 * lin(v[1]) + 0.0722 * lin(v[2]);
  const bar = lum(c.map((v, i) => v * alpha + b[i] * (1 - alpha)));
  // the ink with the higher contrast ratio (WCAG) against the bar
  const dark = lum(rgb("#0b0f17"));
  return (bar + 0.05) / (dark + 0.05) > 1.05 / (bar + 0.05) ? "#0b0f17" : "#ffffff";
}
