/**
 * The commits bookshelf (T95, T133): a shelf per project shown on the table, in the order its cities sit
 * there (from the default camera: the back row first, left to right), its name on a plate; each commit a
 * book on its project's shelf, the newest at the right end; a full shelf keeps its project's newest
 * PER_SHELF. The bookcase is as tall as its shelves, up to MAX_SHELVES: past that, the last shelf takes the
 * rest of the projects together ("Other projects (n)"). Pure, so the layout is tested.
 */
import { FLOOR_Y, SHELF } from "./world";

/** Books per shelf, shelves at most, and books in all (the instances to allocate). */
export const PER_SHELF = 18;
export const MAX_SHELVES = 6;
export const SHELF_BOOKS = PER_SHELF * MAX_SHELVES;

/** The inside width, and a book slot's width. */
const INNER_W = SHELF.w - 2 * SHELF.side;
const SLOT_W = INNER_W / PER_SHELF;

/** A shelf: the project(s) whose books go on it, and the name on its plate. */
export type ShelfRow = { key: string; name: string; repos: string[] };

/**
 * The projects in the order their cities sit on the table, seen from the default camera: rows from the
 * back (smaller z) to the front, each left to right. `cities[i]` sits at `plates[i]`.
 */
export function tableOrder<C extends { repo: string; name: string }>(cities: C[], plates: { x: number; z: number; d: number }[]): C[] {
  const idx = cities.map((_, i) => i);
  // (cities whose centres are within half the smaller one's depth are on one row)
  idx.sort((a, b) => {
    const pa = plates[a], pb = plates[b];
    const sameRow = Math.abs(pa.z - pb.z) < Math.min(pa.d, pb.d) / 2;
    return sameRow ? pa.x - pb.x : pa.z - pb.z;
  });
  return idx.map((i) => cities[i]);
}

/** The shelves for these projects (in table order): one each, the projects past MAX_SHELVES − 1 together on the last when there are too many. */
export function shelfRows(projects: { repo: string; name: string }[]): ShelfRow[] {
  const own = (p: { repo: string; name: string }): ShelfRow => ({ key: p.repo, name: p.name, repos: [p.repo] });
  if (projects.length <= MAX_SHELVES) return projects.map(own);
  const rest = projects.slice(MAX_SHELVES - 1);
  return [...projects.slice(0, MAX_SHELVES - 1).map(own), { key: "other", name: `Other projects (${rest.length})`, repos: rest.map((p) => p.repo) }];
}

/** The bookcase's height for `rows` shelves (one at least). */
export const shelfHeight = (rows: number) => Math.max(1, rows) * (SHELF.gap + SHELF.board) + SHELF.board;
/** The y of shelf `n`'s board top (0 = the top shelf) in a bookcase of `rows` shelves. */
export const boardTop = (n: number, rows: number) => FLOOR_Y + SHELF.board + (Math.max(1, rows) - 1 - n) * (SHELF.gap + SHELF.board);

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

/**
 * Where each commit's book stands: on its project's shelf, the newest at the right end and older ones
 * leftwards; past PER_SHELF on a shelf, that project's oldest aren't shown (absent from the result), nor
 * are commits of a project with no shelf (hidden from the table, or none known). `commits` oldest first,
 * as committed. A book's height and thickness vary a little, repeatably per hash.
 */
export function bookSpots(rows: ShelfRow[], commits: { hash: string; repo: string | null }[]): Map<string, BookSpot> {
  const out = new Map<string, BookSpot>();
  const rowOf = new Map<string, number>();
  rows.forEach((r, i) => r.repos.forEach((repo) => rowOf.set(repo, i)));
  const filled = rows.map(() => 0);
  for (let k = commits.length - 1; k >= 0; k--) {
    const c = commits[k];
    const shelf = c.repo === null ? undefined : rowOf.get(c.repo);
    if (shelf === undefined || filled[shelf] >= PER_SHELF) continue;
    const slot = PER_SHELF - 1 - filled[shelf]++;
    const h = SHELF.gap * (0.7 + 0.2 * rand(c.hash, 1));
    const w = SLOT_W * (0.72 + 0.2 * rand(c.hash, 2));
    out.set(c.hash, {
      x: SHELF.x - SHELF.w / 2 + SHELF.side + (slot + 0.5) * SLOT_W,
      y: boardTop(shelf, rows.length) + h / 2,
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
