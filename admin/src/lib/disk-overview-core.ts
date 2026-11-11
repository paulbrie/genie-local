// Pure, dependency-free (tested): the desktop's Disk widget's figures (disk-overview.ts runs df and du).

/** A filesystem, in bytes: where it's mounted, its size, what's used and what's left to use. */
export type DiskFs = { mount: string; size: number; used: number; avail: number };
/** A folder's space on disk, and its largest entries (folders and files right under it). */
export type DiskPath = { path: string; bytes: number; top: { name: string; bytes: number }[] };
/**
 * A part of what's used on the disk: a folder (its path the key), Docker (what `docker system df` counts, its own key:
 * its folder isn't readable), or the rest (`other`: the used space nothing measured accounts for).
 */
export type DiskPart = { key: string; label: string; bytes: number; top: { name: string; bytes: number }[] };
/**
 * What the widget shows: the filesystems the folders are on (always fresh: df is instant), the parts of what's used
 * (null until the first measuring is done: du on a big tree takes a while), when they were measured, and whether
 * that's under way.
 */
export type DiskOverview = { fs: DiskFs[]; parts: DiskPart[] | null; scannedAt: number | null; scanning: boolean };

/** docker's sizes ("8.033GB", "9.884MB", "0B"): decimal units, as docker prints them. */
export function parseDockerSize(s: string): number {
  const m = /^([\d.]+)\s*([kKMGTP]?)B$/.exec(s.trim());
  if (!m) return 0;
  const exp = { "": 0, k: 1, K: 1, M: 2, G: 3, T: 4, P: 5 }[m[2] as "" | "k" | "K" | "M" | "G" | "T" | "P"];
  return Math.round(Number(m[1]) * 1000 ** exp);
}

/** `docker system df --format '{{.Type}}\t{{.Size}}'`: Docker's part, its kinds (images, volumes…) as its entries. */
export function parseDockerDf(stdout: string): DiskPart | null {
  const top: { name: string; bytes: number }[] = [];
  for (const line of stdout.split("\n")) {
    const [type, size] = line.split("\t");
    if (!type || size === undefined) continue;
    const bytes = parseDockerSize(size);
    if (bytes > 0) top.push({ name: type.trim().toLowerCase(), bytes });
  }
  if (!top.length) return null;
  top.sort((a, b) => b.bytes - a.bytes);
  return { key: "docker", label: "Docker", bytes: top.reduce((n, t) => n + t.bytes, 0), top };
}

/** The used space nothing measured accounts for (the system's own, other users', what can't be read), never below 0. */
export function otherPart(used: number, parts: readonly DiskPart[]): DiskPart {
  return { key: "other", label: "Other", bytes: Math.max(0, used - parts.reduce((n, p) => n + p.bytes, 0)), top: [] };
}

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
