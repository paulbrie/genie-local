// Pure (tested): the room each worktree of a repo takes (worktrees.ts measures them with du).

/**
 * Each worktree's own size, from du's for its whole folder (`measured`, by path; null: not measured): less the
 * worktrees inside it, the ones whose nearest worktree around them it is (Claude Code puts its own under the repo,
 * .claude/worktrees), so nothing counts twice. A worktree's figure stays null when its own is.
 */
export function ownSizes(measured: Record<string, number | null>): Record<string, number | null> {
  const paths = Object.keys(measured);
  const inside = (p: string, dir: string) => p !== dir && p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
  // (the nearest worktree around one: the longest path it's inside)
  const around = (p: string) => paths.filter((d) => inside(p, d)).sort((a, b) => b.length - a.length)[0];
  const out: Record<string, number | null> = { ...measured };
  for (const p of paths) {
    const outer = around(p);
    const own = measured[p];
    if (outer && own != null && out[outer] != null) out[outer] = Math.max(0, out[outer]! - own);
  }
  return out;
}

/** `du -sxB1 <dir>`: the total, in bytes; null when du said nothing of it. */
export function parseDuTotal(stdout: string): number | null {
  const last = stdout.trim().split("\n").pop() ?? "";
  const n = Number(last.split("\t")[0]);
  return last.includes("\t") && Number.isFinite(n) ? n : null;
}
