/**
 * Zoom and pan of the Ops view's isometric map (T200), as pure maths. The map is drawn fitted to its box (`Fit`); a
 * view `{ s, tx, ty }` scales that by `s` and moves it by `tx, ty` (screen pixels): a point at `q` on the fitted map is
 * at `s·q + t` on screen. During a gesture the drawn layers only get a CSS transform (`cssBetween`); the layers are
 * drawn again, and the labels picked again, when it ends.
 */
import type { P2 } from "./iso";

export type View = { s: number; tx: number; ty: number };
export type Fit = { k: number; ox: number; oy: number };
export const FIT_VIEW: View = { s: 1, tx: 0, ty: 0 };
/** least zoom: a little smaller than the whole map */
export const MIN_S = 0.6;

/** the most zoom: about `files` world units (a few files' footprints) across the box */
export const maxS = (fit: Fit, w: number, files = 14) => Math.max(2, w / (files * fit.k));

/** the fit with the view applied: what the layers draw with, and what hit tests use */
export const viewFit = (fit: Fit, v: View): Fit => ({ k: fit.k * v.s, ox: fit.ox * v.s + v.tx, oy: fit.oy * v.s + v.ty });

/** the view zoomed by `f` about screen point `m` (that point stays put), the zoom held to [MIN_S, max] */
export function zoomAt(v: View, f: number, m: P2, max: number): View {
  const s = Math.min(max, Math.max(MIN_S, v.s * f)), r = s / v.s;
  return { s, tx: m.x - (m.x - v.tx) * r, ty: m.y - (m.y - v.ty) * r };
}

export const panBy = (v: View, dx: number, dy: number): View => ({ s: v.s, tx: v.tx + dx, ty: v.ty + dy });

/** the CSS transform taking what was drawn for view `from` to where view `to` puts it (origin at the top left) */
export function cssBetween(from: View, to: View): string {
  const r = to.s / from.s;
  return `translate(${(to.tx - r * from.tx).toFixed(2)}px, ${(to.ty - r * from.ty).toFixed(2)}px) scale(${r.toFixed(5)})`;
}

/** the view showing screen box `b` (as the fitted map draws it) as large as fits in `w × h`, centred, with a margin */
export function viewOfBox(b: { x0: number; y0: number; x1: number; y1: number }, w: number, h: number, max: number, pad = 40): View {
  const s = Math.min(max, Math.max(MIN_S, Math.min((w - pad * 2) / Math.max(1, b.x1 - b.x0), (h - pad * 2) / Math.max(1, b.y1 - b.y0))));
  return { s, tx: w / 2 - s * (b.x0 + b.x1) / 2, ty: h / 2 - s * (b.y0 + b.y1) / 2 };
}

/** the view kept for the session, as the fitted map's point at the middle and the zoom (so it survives a resize) */
export const viewToStore = (v: View, w: number, h: number) => ({ s: v.s, cx: (w / 2 - v.tx) / v.s, cy: (h / 2 - v.ty) / v.s });
export function viewFromStore(x: unknown, w: number, h: number, max: number): View | null {
  if (!x || typeof x !== "object" || !("s" in x) || !("cx" in x) || !("cy" in x)) return null;
  const { s, cx, cy } = x;
  if (typeof s !== "number" || typeof cx !== "number" || typeof cy !== "number" || !Number.isFinite(s + cx + cy)) return null;
  const z = Math.min(max, Math.max(MIN_S, s));
  return { s: z, tx: w / 2 - z * cx, ty: h / 2 - z * cy };
}
