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

function endTarget(doc: BoardDoc, e: ConnectorEnd): BoardObject | null {
  const o = e.id ? doc.objects[e.id] : null;
  return o && o.type !== "connector" ? o : null;
}

/** The two drawn ends of a connector, clipped to the boxes it's attached to. */
export function connectorPoints(doc: BoardDoc, c: Connector): { a: Pt; b: Pt } {
  const A = endTarget(doc, c.from);
  const B = endTarget(doc, c.to);
  const ca = A ? center(A) : { x: c.from.x, y: c.from.y };
  const cb = B ? center(B) : { x: c.to.x, y: c.to.y };
  return { a: A ? boundaryPoint(A, cb) : ca, b: B ? boundaryPoint(B, ca) : cb };
}

/** An object's box; a connector's is the box around its two ends. */
export function bounds(doc: BoardDoc, o: BoardObject): Rect {
  if (o.type === "connector") {
    const { a, b } = connectorPoints(doc, o);
    return normRect(a, b);
  }
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

const SECTION_TITLE_H = 28;

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
        const { a, b } = connectorPoints(doc, o);
        if (distToSegment(p, a, b) <= slop + 2) return o;
        break;
      }
      case "pen":
        if (penHit(o, p, slop)) return o;
        break;
      case "section": {
        const inX = p.x >= o.x - slop && p.x <= o.x + o.w + slop;
        const inY = p.y >= o.y - slop && p.y <= o.y + o.h + slop;
        const title = p.x >= o.x && p.x <= o.x + Math.min(o.w, 260) && p.y >= o.y - SECTION_TITLE_H / Math.max(zoom, 0.5) && p.y <= o.y;
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
