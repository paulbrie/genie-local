// Pure, dependency-free (tested): the desktop's Disk widget's figures (disk-overview.ts runs df and du).

/** A filesystem, in bytes: where it's mounted, its size, what's used and what's left to use. */
export type DiskFs = { mount: string; size: number; used: number; avail: number };
/** A folder's space on disk, and its largest entries (folders and files right under it). */
export type DiskPath = { path: string; bytes: number; top: { name: string; bytes: number }[] };
/**
 * What the widget shows: the filesystems the folders are on (always fresh: df is instant), the folders (null until
 * the first measuring is done: du on a big tree takes a while), when they were measured, and whether that's under way.
 */
export type DiskOverview = { fs: DiskFs[]; paths: DiskPath[] | null; scannedAt: number | null; scanning: boolean };

/** `df -B1 --output=target,size,used,avail …`: each filesystem once (two folders on one disk are one row). */
export function parseDf(stdout: string): DiskFs[] {
  const out: DiskFs[] = [];
  for (const line of stdout.split("\n").slice(1)) {
    const m = /^(\S.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m || out.some((f) => f.mount === m[1])) continue;
    out.push({ mount: m[1], size: Number(m[2]), used: Number(m[3]), avail: Number(m[4]) });
  }
  return out;
}

/** `du -axB1 --max-depth=1 <root>`: the root's total, and its `n` largest entries by name. Null: du said nothing of it. */
export function parseDuTop(stdout: string, root: string, n = 5): DiskPath | null {
  const base = root.replace(/\/+$/, "") || "/";
  let bytes: number | null = null;
  const entries: { name: string; bytes: number }[] = [];
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const size = Number(line.slice(0, tab));
    const p = line.slice(tab + 1);
    if (p === base) bytes = size;
    else if (p.startsWith(base === "/" ? "/" : `${base}/`)) entries.push({ name: p.slice(base === "/" ? 1 : base.length + 1), bytes: size });
  }
  if (bytes === null) return null;
  entries.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  return { path: base, bytes, top: entries.slice(0, n) };
}
