/**
 * The commits bookshelf (T95): each commit a book, the newest at the end of the
 * top shelf, then leftwards and down the shelves; a full shelf keeps the newest
 * SHELF_BOOKS. Pure, so the layout and the capacity are tested.
 */
import { FLOOR_Y, SHELF } from "./world";

/** Books per shelf and in all: the shelf keeps the newest this many. */
export const PER_SHELF = 18;
export const SHELF_BOOKS = PER_SHELF * SHELF.shelves;

/** The inside height between two boards. */
export const GAP = (SHELF.h - SHELF.board * (SHELF.shelves + 1)) / SHELF.shelves;
/** The inside width, and a book slot's width. */
const INNER_W = SHELF.w - 2 * SHELF.side;
const SLOT_W = INNER_W / PER_SHELF;

/** A repeatable 0–1 from a commit's hash, for its book's size. */
function rand(hash: string, salt: number): number {
  let h = salt * 0x9e3779b1;
  for (let i = 0; i < hash.length; i++) h = Math.imul(h ^ hash.charCodeAt(i), 0x01000193);
  return ((h ^ (h >>> 15)) >>> 0) / 2 ** 32;
}

export type BookSpot = {
  /** Centre (world), standing on its board. */
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  /** Shelf from the top (0) and slot from the left. */
  shelf: number;
  slot: number;
};

/** The y of shelf `n`'s board top (0 = the top shelf). */
export const boardTop = (n: number) => FLOOR_Y + SHELF.board + (SHELF.shelves - 1 - n) * (GAP + SHELF.board);

/**
 * Where each of `hashes` (oldest first, as committed) stands: the newest at the
 * right end of the top shelf, older ones leftwards then down; past SHELF_BOOKS,
 * the oldest aren't shown (absent from the result). A book's height and
 * thickness vary a little, repeatably per hash.
 */
export function bookSpots(hashes: string[]): Map<string, BookSpot> {
  const out = new Map<string, BookSpot>();
  const n = Math.min(hashes.length, SHELF_BOOKS);
  for (let k = 0; k < n; k++) {
    const hash = hashes[hashes.length - 1 - k];
    const shelf = Math.floor(k / PER_SHELF);
    const slot = PER_SHELF - 1 - (k % PER_SHELF);
    const h = GAP * (0.7 + 0.2 * rand(hash, 1));
    const w = SLOT_W * (0.72 + 0.2 * rand(hash, 2));
    out.set(hash, {
      x: SHELF.x - SHELF.w / 2 + SHELF.side + (slot + 0.5) * SLOT_W,
      y: boardTop(shelf) + h / 2,
      z: SHELF.z + SHELF.d * 0.1,
      w,
      h,
      d: SHELF.d * 0.7,
      shelf,
      slot,
    });
  }
  return out;
}
