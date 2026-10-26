import type { BoardDoc, BoardObject, Connector, ConnectorEnd } from "@/lib/boards/core.mjs";

/** Screen = world * zoom + (tx, ty). */
export type View = { tx: number; ty: number; zoom: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type Pt = { x: number; y: number };

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

export function toWorld(v: View, sx: number, sy: number): Pt {
  return { x: (sx - v.tx) / v.zoom, y: (sy - v.ty) / v.zoom };
}

export function zoomAt(v: View, sx: number, sy: number, zoom: number): View {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  const w = toWorld(v, sx, sy);
  return { zoom: z, tx: sx - w.x * z, ty: sy - w.y * z };
}

/** A view that shows `r` inside a w×h screen with some margin. */
export function fitView(r: Rect | null, w: number, h: number, maxZoom = 1, m = 80): View {
  if (!r) return { tx: w / 2, ty: h / 2, zoom: 1 };
  const zoom = Math.min(maxZoom, Math.max(MIN_ZOOM, Math.min((w - m * 2) / Math.max(1, r.w), (h - m * 2) / Math.max(1, r.h))));
  return { zoom, tx: w / 2 - (r.x + r.w / 2) * zoom, ty: h / 2 - (r.y + r.h / 2) * zoom };
}

export function center(r: Rect): Pt {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function intersects(a: Rect, b: Rect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function contains(outer: Rect, inner: Rect) {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

export function normRect(a: Pt, b: Pt): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/**
 * The box an object actually occupies on screen. A folded section shows only
 * its bar, so that — not the frame it stands for — is what lines meet, what you
 * can grab, and what the selection ring goes round.
 */
export function visualRect(o: BoardObject): Rect {
  if (o.type === "section" && o.collapsed) return { x: o.x, y: o.y, w: sectionBarW(o), h: sectionBarH(o) };
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}

/** A point on a box's border from a 0..1 position, with the way out of it. */
export function anchorPoint(o: Rect, at: Pt, gap = 4): { p: Pt; dir: Pt } {
  const x = o.x + at.x * o.w;
  const y = o.y + at.y * o.h;
  // Which edge it sits on decides the way out; a corner leans both ways.
  let dx = 0;
  let dy = 0;
  if (at.x <= 0.001) dx = -1;
  else if (at.x >= 0.999) dx = 1;
  if (at.y <= 0.001) dy = -1;
  else if (at.y >= 0.999) dy = 1;
  if (!dx && !dy) {
    // Not on an edge: head away from the middle.
    dx = at.x - 0.5;
    dy = at.y - 0.5;
  }
  const len = Math.hypot(dx, dy) || 1;
  const dir = { x: dx / len, y: dy / len };
  return { p: { x: x + dir.x * gap, y: y + dir.y * gap }, dir };
}

/** The place on a box's border nearest `p`, as a 0..1 position. */
export function nearestAnchor(o: Rect, p: Pt): Pt {
  const fx = Math.min(1, Math.max(0, (p.x - o.x) / Math.max(o.w, 1)));
  const fy = Math.min(1, Math.max(0, (p.y - o.y) / Math.max(o.h, 1)));
  // Push whichever edge is closest out to it, so the point lands on the border.
  const d = [fx, 1 - fx, fy, 1 - fy];
  const min = Math.min(...d);
  if (min === d[0]) return { x: 0, y: fy };
  if (min === d[1]) return { x: 1, y: fy };
  if (min === d[2]) return { x: fx, y: 0 };
  return { x: fx, y: 1 };
}

/** How far from a border a drop still counts as pinning to it, in board units. */
export const ANCHOR_BAND = 26;

/** Is `p` close enough to this box's border to mean a specific spot on it? */
export function nearBorder(o: Rect, p: Pt) {
  const inside = p.x >= o.x && p.x <= o.x + o.w && p.y >= o.y && p.y <= o.y + o.h;
  if (!inside) return false;
  return Math.min(p.x - o.x, o.x + o.w - p.x, p.y - o.y, o.y + o.h - p.y) <= ANCHOR_BAND;
}

/** Where a line should meet a shape when nobody has said: the side it heads for. */
function autoAt(o: Rect, towards: Pt): Pt {
  const c = center(o);
  const dx = towards.x - c.x;
  const dy = towards.y - c.y;
  return Math.abs(dx) / Math.max(o.w / 2, 1) >= Math.abs(dy) / Math.max(o.h / 2, 1)
    ? { x: dx >= 0 ? 1 : 0, y: 0.5 }
    : { x: 0.5, y: dy >= 0 ? 1 : 0 };
}

function endTarget(doc: BoardDoc, e: ConnectorEnd): BoardObject | null {
  const o = e.id ? doc.objects[e.id] : null;
  return o && o.type !== "connector" ? o : null;
}

export type ConnectorCurve = {
  a: Pt;
  b: Pt;
  /** The middle of the drawn line, where the handle that shapes it sits. */
  mid: Pt;
  /** Points along it, for hit-testing, bounds and pointing the arrowheads. */
  points: Pt[];
  path: string;
};

/**
 * Everything about how a connector is drawn, in one place so the picture, the
 * hit-test and the arrowheads can never disagree. A line is curved unless it
 * says otherwise; a curve leaves each shape square-on, and once someone drags
 * its middle it bows through wherever they put it.
 */
export function connectorCurve(doc: BoardDoc, c: Connector): ConnectorCurve {
  const A = endTarget(doc, c.from);
  const B = endTarget(doc, c.to);
  // Each end meets whatever the shape currently shows, so folding a section
  // leaves the lines on it joined to the bar it became.
  const boxA = A && visualRect(A);
  const boxB = B && visualRect(B);
  const rawA = boxA ? center(boxA) : { x: c.from.x, y: c.from.y };
  const rawB = boxB ? center(boxB) : { x: c.to.x, y: c.to.y };
  const endOf = (box: Rect | null | undefined, at: Pt | undefined, towards: Pt, loose: Pt) =>
    box ? anchorPoint(box, at ?? autoAt(box, towards)) : { p: loose, dir: { x: 0, y: 0 } };
  const from = endOf(boxA, c.from.at, rawB, rawA);
  const to = endOf(boxB, c.to.at, rawA, rawB);
  const a = from.p;
  const b = to.p;
  const chord = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

  if (c.straight) {
    return { a, b, mid: chord, points: [a, b], path: `M${a.x} ${a.y}L${b.x} ${b.y}` };
  }

  // Bowed by hand: a quadratic whose middle passes through the handle.
  if (c.bend) {
    const h = { x: chord.x + c.bend.x, y: chord.y + c.bend.y };
    const ctrl = { x: 2 * h.x - (a.x + b.x) / 2, y: 2 * h.y - (a.y + b.y) / 2 };
    const at = (t: number) => {
      const u = 1 - t;
      return { x: u * u * a.x + 2 * u * t * ctrl.x + t * t * b.x, y: u * u * a.y + 2 * u * t * ctrl.y + t * t * b.y };
    };
    const points = Array.from({ length: 17 }, (_, i) => at(i / 16));
    return { a, b, mid: h, points, path: `M${a.x} ${a.y}Q${ctrl.x} ${ctrl.y} ${b.x} ${b.y}` };
  }

  // Otherwise a gentle S, leaving and arriving at right angles to each shape.
  const away = (p: Pt, other: Pt): Pt => {
    const dx = other.x - p.x;
    const dy = other.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  };
  const da = from.dir.x || from.dir.y ? from.dir : away(a, b);
  const db = to.dir.x || to.dir.y ? to.dir : away(b, a);
  const pull = Math.max(40, Math.min(220, Math.hypot(b.x - a.x, b.y - a.y) * 0.45));
  const c1 = { x: a.x + da.x * pull, y: a.y + da.y * pull };
  const c2 = { x: b.x + db.x * pull, y: b.y + db.y * pull };
  const at = (t: number) => {
    const u = 1 - t;
    return {
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    };
  };
  const points = Array.from({ length: 17 }, (_, i) => at(i / 16));
  return { a, b, mid: at(0.5), points, path: `M${a.x} ${a.y}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}` };
}

/** An object's box; a connector's is the box around its two ends. */
export function bounds(doc: BoardDoc, o: BoardObject): Rect {
  if (o.type === "connector") {
    return unionRect(connectorCurve(doc, o).points.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })))!;
  }
  return visualRect(o);
}

export function unionRect(rs: Rect[]): Rect | null {
  if (!rs.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rs) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function distToSegment(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function penHit(o: BoardObject & { type: "pen" }, p: Pt, slop: number) {
  if (p.x < o.x - slop || p.y < o.y - slop || p.x > o.x + o.w + slop || p.y > o.y + o.h + slop) return false;
  const pts = o.points;
  const tol = o.width / 2 + slop;
  for (let i = 0; i < pts.length; i++) {
    const a = { x: o.x + pts[i][0], y: o.y + pts[i][1] };
    const b = i + 1 < pts.length ? { x: o.x + pts[i + 1][0], y: o.y + pts[i + 1][1] } : a;
    if (distToSegment(p, a, b) <= tol) return true;
  }
  return false;
}

/** The tab above a frame, which is how you grab it; it grows with the title. */
export function sectionTitleH(o: { fontSize?: number }) {
  return (o.fontSize ?? 13) * 1.1 + 12;
}
/** A folded section is just this bar, where the top of its frame was. */
export const SECTION_BAR_H = 44;
/**
 * A folded bar is sized by its title rather than by the frame it stands for, so
 * a short name doesn't leave a long empty strip. Estimated from the character
 * count — hit-testing needs this without touching the DOM — and generous enough
 * that the text isn't clipped.
 */
export function sectionBarW(o: { title?: string; fontSize?: number; collapsed?: true }) {
  const fs = o.fontSize ?? 13;
  const chars = (o.title || "Section").length;
  return Math.max(140, Math.min(680, Math.round(chars * fs * 0.62 + fs * 2 + 76)));
}

/** …taller when its title is set large. */
export function sectionBarH(o: { fontSize?: number }) {
  return Math.max(SECTION_BAR_H, Math.round((o.fontSize ?? 13) * 2.2));
}

/**
 * The topmost object under a world point. Sections are only grabbed by their
 * title or their edge, so a drag inside one starts a marquee like in FigJam.
 */
export function hitTest(doc: BoardDoc, sorted: BoardObject[], p: Pt, zoom: number): BoardObject | null {
  const slop = 6 / zoom;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const o = sorted[i];
    switch (o.type) {
      case "connector": {
        const pts = connectorCurve(doc, o).points;
        for (let s = 0; s < pts.length - 1; s++) {
          if (distToSegment(p, pts[s], pts[s + 1]) <= slop + 2) return o;
        }
        break;
      }
      case "pen":
        if (penHit(o, p, slop)) return o;
        break;
      case "section": {
        if (o.collapsed) {
          // Folded: the bar is the whole of it, and grabbing it moves it.
          if (p.x >= o.x && p.x <= o.x + sectionBarW(o) && p.y >= o.y && p.y <= o.y + sectionBarH(o)) return o;
          break;
        }
        const inX = p.x >= o.x - slop && p.x <= o.x + o.w + slop;
        const inY = p.y >= o.y - slop && p.y <= o.y + o.h + slop;
        const titleH = sectionTitleH(o);
        const title = p.x >= o.x && p.x <= o.x + Math.max(260, o.w) && p.y >= o.y - titleH && p.y <= o.y;
        const edge = inX && inY && (p.x - o.x < slop * 2 || o.x + o.w - p.x < slop * 2 || p.y - o.y < slop * 2 || o.y + o.h - p.y < slop * 2);
        if (title || edge) return o;
        break;
      }
      case "comment":
        if (Math.hypot(p.x - (o.x + 16), p.y - (o.y + 16)) <= 18 / Math.min(1, zoom)) return o;
        break;
      default:
        if (p.x >= o.x && p.x <= o.x + o.w && p.y >= o.y && p.y <= o.y + o.h) return o;
    }
  }
  return null;
}

/** Things a connector can attach to under a point (not connectors, pens or comments). */
export function attachTarget(sorted: BoardObject[], p: Pt, exclude?: string): BoardObject | null {
  for (let i = sorted.length - 1; i >= 0; i--) {
    const o = sorted[i];
    if (o.id === exclude || o.type === "connector" || o.type === "pen" || o.type === "comment") continue;
    if (p.x >= o.x && p.x <= o.x + o.w && p.y >= o.y && p.y <= o.y + o.h) return o;
  }
  return null;
}

/** A smooth SVG path through freehand points (quadratic midpoints). */
export function penPath(points: [number, number][]): string {
  if (points.length === 1) {
    const [x, y] = points[0];
    return `M${x} ${y}L${x + 0.1} ${y}`;
  }
  let d = `M${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += `Q${x} ${y} ${(x + nx) / 2} ${(y + ny) / 2}`;
  }
  const last = points[points.length - 1];
  return `${d}L${last[0]} ${last[1]}`;
}

/** Drop points closer than `min` to the previous one (keeps pen strokes light). */
export function simplify(points: [number, number][], min: number): [number, number][] {
  const out: [number, number][] = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= min) out.push(p);
  }
  const last = points[points.length - 1];
  if (last && out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * The part of the view not covered by the toolbars (and the Claude panel when
 * it's open) — where someone's cursor is actually visible.
 */
export type Insets = { top: number; right: number; bottom: number; left: number };

function clear(w: number, h: number, i: Insets) {
  const x1 = i.left;
  const y1 = i.top;
  const x2 = Math.max(x1 + 2, w - i.right);
  const y2 = Math.max(y1 + 2, h - i.bottom);
  return { x1, y1, x2, y2, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, hw: (x2 - x1) / 2, hh: (y2 - y1) / 2 };
}

/**
 * Where a point outside the view meets the edge of it, for the markers that
 * show someone working off-screen: the spot on the clear border that the line
 * from the middle of the view to `p` crosses, plus the angle to point an arrow.
 */
export function edgePoint(w: number, h: number, p: Pt, i: Insets): { x: number; y: number; angle: number } {
  const c = clear(w, h, i);
  const dx = p.x - c.cx;
  const dy = p.y - c.cy;
  const t = Math.min(c.hw / Math.max(Math.abs(dx), 1e-9), c.hh / Math.max(Math.abs(dy), 1e-9));
  return { x: c.cx + dx * t, y: c.cy + dy * t, angle: Math.atan2(dy, dx) };
}

/** Is this screen point outside the part of the view you can actually see? */
export function offScreen(w: number, h: number, p: Pt, i: Insets) {
  const c = clear(w, h, i);
  return p.x < c.x1 || p.y < c.y1 || p.x > c.x2 || p.y > c.y2;
}
