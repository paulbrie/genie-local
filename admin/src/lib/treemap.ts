// Pure, dependency-free (tested): a squarified treemap (Bruls, Huizing & van Wijk), for the Disk widget.

export type TreeItem = { key: string; value: number };
export type TreeRect = { key: string; x: number; y: number; w: number; h: number };

/** The worst aspect ratio of a row of `areas` laid along a side `side` long. */
function worst(areas: number[], side: number): number {
  const sum = areas.reduce((n, a) => n + a, 0);
  const max = Math.max(...areas);
  const min = Math.min(...areas);
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

/**
 * `items` (by value, the biggest first; nothing at 0 or below) tiling the box x, y, w, h: each its share of the area,
 * as close to square as rows along the box's shorter side allow.
 */
export function squarify(items: readonly TreeItem[], x: number, y: number, w: number, h: number): TreeRect[] {
  const list = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const total = list.reduce((n, i) => n + i.value, 0);
  if (!list.length || w <= 0 || h <= 0) return [];
  const scale = (w * h) / total;
  const out: TreeRect[] = [];
  let box = { x, y, w, h };
  let row: { key: string; area: number }[] = [];
  const lay = () => {
    const sum = row.reduce((n, r) => n + r.area, 0);
    if (box.w >= box.h) {
      // a column at the left, as wide as the row's area over the height
      const cw = sum / box.h;
      let cy = box.y;
      for (const r of row) {
        const rh = r.area / cw;
        out.push({ key: r.key, x: box.x, y: cy, w: cw, h: rh });
        cy += rh;
      }
      box = { x: box.x + cw, y: box.y, w: box.w - cw, h: box.h };
    } else {
      // a row along the top
      const rh = sum / box.w;
      let cx = box.x;
      for (const r of row) {
        const rw = r.area / rh;
        out.push({ key: r.key, x: cx, y: box.y, w: rw, h: rh });
        cx += rw;
      }
      box = { x: box.x, y: box.y + rh, w: box.w, h: box.h - rh };
    }
    row = [];
  };
  for (const item of list) {
    const area = item.value * scale;
    const side = Math.min(box.w, box.h);
    const areas = row.map((r) => r.area);
    if (row.length && worst([...areas, area], side) > worst(areas, side)) lay();
    row.push({ key: item.key, area });
  }
  if (row.length) lay();
  return out;
}
