/**
 * Floating terminal windows' position and size: parsing what was stored (any
 * bad or old value is ignored) and keeping a window inside the viewport. Pure,
 * so it is unit-tested; terminal-dock.tsx does the storage and the DOM.
 */
export type Pos = { x: number; y: number };
export type Size = { w: number; h: number };
export type Geom = Pos & Size;

/** The window's CSS default (w-[44rem] h-[26rem]) and minimum (min-w-[20rem] min-h-[12rem]). */
export const DEFAULT_SIZE: Size = { w: 704, h: 416 };
export const MIN_SIZE: Size = { w: 320, h: 192 };
/** The CSS caps (max-w-[92vw] max-h-[90vh]), so the stored size is what is drawn. */
const MAX_W = 0.92;
const MAX_H = 0.9;

const num = (v: unknown, min: number): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= min ? v : null;

/** A stored `{x, y, w, h}`: each pair is kept only if both of its values are valid. */
export function parseGeom(raw: string | null): { pos: Pos | null; size: Size | null } {
  let s: Record<string, unknown>;
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return { pos: null, size: null };
    s = v as Record<string, unknown>;
  } catch {
    return { pos: null, size: null };
  }
  const x = num(s.x, 0);
  const y = num(s.y, 0);
  const w = num(s.w, MIN_SIZE.w);
  const h = num(s.h, MIN_SIZE.h);
  return {
    pos: x !== null && y !== null ? { x, y } : null,
    size: w !== null && h !== null ? { w, h } : null,
  };
}

/**
 * Fit a window in a `vw` × `vh` viewport: shrink it to the viewport's caps if
 * larger, then move it so the title bar is fully visible and as much of the
 * body as fits (top-left wins when it can't all fit).
 */
export function clampGeom(g: Geom, vw: number, vh: number): Geom {
  const w = Math.round(Math.max(Math.min(MIN_SIZE.w, vw), Math.min(g.w, vw * MAX_W)));
  const h = Math.round(Math.max(Math.min(MIN_SIZE.h, vh), Math.min(g.h, vh * MAX_H)));
  const x = Math.round(Math.min(Math.max(0, g.x), Math.max(0, vw - w)));
  const y = Math.round(Math.min(Math.max(0, g.y), Math.max(0, vh - h)));
  return { x, y, w, h };
}

export function sameGeom(a: Geom, b: Geom): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
