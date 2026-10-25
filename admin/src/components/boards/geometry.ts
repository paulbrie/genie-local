import type { BoardDoc, BoardObject, Connector, ConnectorEnd, Side } from "@/lib/boards/core.mjs";

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

/** Where a line from the box centre toward `p` leaves the box (ellipses too). */
function boundaryPoint(o: BoardObject, p: Pt, gap = 4): Pt {
  const c = center(o);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const hw = o.w / 2 + gap;
  const hh = o.h / 2 + gap;
  let t: number;
  if (o.type === "shape" && o.shape === "ellipse") {
    t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  } else if (o.type === "shape" && o.shape === "diamond") {
    t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  } else {
    t = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  }
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** The middle of one side of a box, and the direction pointing out of it. */
export function sidePoint(o: BoardObject, side: Side, gap = 4): { p: Pt; dir: Pt } {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  switch (side) {
    case "top":
      return { p: { x: cx, y: o.y - gap }, dir: { x: 0, y: -1 } };
    case "bottom":
      return { p: { x: cx, y: o.y + o.h + gap }, dir: { x: 0, y: 1 } };
    case "left":
      return { p: { x: o.x - gap, y: cy }, dir: { x: -1, y: 0 } };
    default:
      return { p: { x: o.x + o.w + gap, y: cy }, dir: { x: 1, y: 0 } };
  }
}

/**
 * The side a line should leave by when nobody pinned one: whichever the other
 * end lies off, measured against the box's own proportions so a wide box isn't
 * always left-and-right.
 */
export function autoSide(o: BoardObject, towards: Pt): Side {
  const c = center(o);
  const dx = towards.x - c.x;
  const dy = towards.y - c.y;
  return Math.abs(dx) / Math.max(o.w / 2, 1) >= Math.abs(dy) / Math.max(o.h / 2, 1)
    ? dx >= 0
      ? "right"
      : "left"
    : dy >= 0
      ? "bottom"
      : "top";
}

/** The four places a line can be pinned on a box. */
export function sideHandles(o: BoardObject): { side: Side; p: Pt }[] {
  return (["top", "right", "bottom", "left"] as Side[]).map((side) => ({ side, p: sidePoint(o, side, 0).p }));
}

function endTarget(doc: BoardDoc, e: ConnectorEnd): BoardObject | null {
  const o = e.id ? doc.objects[e.id] : null;
  return o && o.type !== "connector" ? o : null;
}

/**
 * The two drawn ends of a connector. An end attached to a box meets it where a
 * line to the other end leaves it, or — if a side was chosen — at the middle of
 * that side. `da`/`db` point out of each end, which is what curves follow.
 */
export function connectorPoints(doc: BoardDoc, c: Connector): { a: Pt; b: Pt; da: Pt; db: Pt } {
  const A = endTarget(doc, c.from);
  const B = endTarget(doc, c.to);
  const ca = A ? center(A) : { x: c.from.x, y: c.from.y };
  const cb = B ? center(B) : { x: c.to.x, y: c.to.y };
  const end = (o: BoardObject | null, side: Side | undefined, towards: Pt, fallback: Pt) => {
    if (!o) return { p: fallback, dir: null };
    if (side) return sidePoint(o, side);
    // A curve always meets a shape square-on — that right angle is what gives it
    // its shape — so an unpinned end takes the side it is heading for.
    if (c.curved) return sidePoint(o, autoSide(o, towards));
    return { p: boundaryPoint(o, towards), dir: null };
  };
  const from = end(A, c.from.side, cb, ca);
  const to = end(B, c.to.side, ca, cb);
  // With no pinned side, a curve leaves along the line between the two ends.
  const away = (p: Pt, other: Pt): Pt => {
    const dx = other.x - p.x;
    const dy = other.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  };
  return {
    a: from.p,
    b: to.p,
    da: from.dir ?? away(from.p, to.p),
    db: to.dir ?? away(to.p, from.p),
  };
}

/** A connector's path: a straight line, or a curve leaving each end head-on. */
export function connectorPath(a: Pt, b: Pt, da: Pt, db: Pt, curved: boolean | undefined): string {
  if (!curved) return `M${a.x} ${a.y}L${b.x} ${b.y}`;
  // Control points reach out along each end's direction, by a share of the gap.
  const pull = Math.max(40, Math.min(220, Math.hypot(b.x - a.x, b.y - a.y) * 0.45));
  const c1 = { x: a.x + da.x * pull, y: a.y + da.y * pull };
  const c2 = { x: b.x + db.x * pull, y: b.y + db.y * pull };
  return `M${a.x} ${a.y}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`;
}

/** Points along a connector, for hit-testing a curve as well as a line. */
export function connectorSamples(a: Pt, b: Pt, da: Pt, db: Pt, curved: boolean | undefined): Pt[] {
  if (!curved) return [a, b];
  const pull = Math.max(40, Math.min(220, Math.hypot(b.x - a.x, b.y - a.y) * 0.45));
  const c1 = { x: a.x + da.x * pull, y: a.y + da.y * pull };
  const c2 = { x: b.x + db.x * pull, y: b.y + db.y * pull };
  const out: Pt[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const u = 1 - t;
    out.push({
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    });
  }
  return out;
}

/** Where the line actually arrives, so an arrowhead can point along it. */
export function arrivalFrom(a: Pt, b: Pt, da: Pt, db: Pt, curved: boolean | undefined): { atB: Pt; atA: Pt } {
  if (!curved) return { atB: a, atA: b };
  const pull = Math.max(40, Math.min(220, Math.hypot(b.x - a.x, b.y - a.y) * 0.45));
  return {
    atB: { x: b.x + db.x * pull, y: b.y + db.y * pull },
    atA: { x: a.x + da.x * pull, y: a.y + da.y * pull },
  };
}

/** An object's box; a connector's is the box around its two ends. */
export function bounds(doc: BoardDoc, o: BoardObject): Rect {
  if (o.type === "connector") {
    const { a, b, da, db } = connectorPoints(doc, o);
    return unionRect(connectorSamples(a, b, da, db, o.curved).map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })))!;
  }
  // A folded section is only as tall as its bar, so selecting it, and the ring
  // around it, match what you can actually see.
  if (o.type === "section" && o.collapsed) return { x: o.x, y: o.y, w: sectionBarW(o), h: sectionBarH(o) };
  return { x: o.x, y: o.y, w: o.w, h: o.h };
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
        const { a, b, da, db } = connectorPoints(doc, o);
        const pts = connectorSamples(a, b, da, db, o.curved);
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
