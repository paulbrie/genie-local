"use client";

import { GitBranch, GitMerge, Lock } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { GitMergeDialog } from "@/components/git-merge-dialog";
import { Button } from "@/components/ui/button";
import { BASE_PATH } from "@/lib/config";
import { formatRelativeTime } from "@/lib/format";
import type { Worktree } from "@/lib/worktrees";

/** "/home/genie/bob-scratch/trafficsim-wt" → "~/bob-scratch/trafficsim-wt"; a worktree inside the repo → its relative path. */
function shortPath(p: string, repo: string): string {
  if (p === repo) return ".";
  if (p.startsWith(repo + "/")) return p.slice(repo.length + 1);
  return p.replace(/^\/home\/[^/]+/, "~");
}

/**
 * The repo's worktrees (where agents work on their own branches): branch, HEAD,
 * uncommitted changes, ahead / behind the main checkout, last commit, and the
 * terminals working in each.
 */
export function GitWorktrees({
  projectSlug,
  app,
  refreshKey = 0,
  onMerged,
}: {
  projectSlug: string;
  app: string;
  /** bumped by the Git tab's Refresh: re-read */
  refreshKey?: number;
  /** a branch was merged locally: the history should reload */
  onMerged?: () => void;
}) {
  const [trees, setTrees] = useState<Worktree[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // the merge dialog: null = closed; "" = pick a branch
  const [merge, setMerge] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`${BASE_PATH}/api/git/worktrees?project=${encodeURIComponent(projectSlug)}&app=${encodeURIComponent(app)}`, { cache: "no-store" })
      .then(async (r) => {
        const json = (await r.json()) as { worktrees?: Worktree[]; error?: string };
        if (!active) return;
        if (!r.ok) setError(json.error ?? `HTTP ${r.status}`);
        else setTrees(json.worktrees ?? []);
      })
      .catch((e) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [projectSlug, app, reload, refreshKey]);

  if (error) return <p className="text-xs text-destructive">Couldn&apos;t list the worktrees: {error}</p>;
  if (!trees) return <p className="text-xs text-muted-foreground">Loading worktrees…</p>;
  // one worktree = just the repo itself: nothing to show
  const dialog = merge != null && (
    <GitMergeDialog
      projectSlug={projectSlug}
      app={app}
      initialBranch={merge || null}
      onClose={() => setMerge(null)}
      onMerged={() => {
        setReload((n) => n + 1);
        onMerged?.();
      }}
    />
  );
  if (trees.length < 2)
    return (
      <div className="flex justify-end">
        <Button size="sm" variant="outline" className="h-7" onClick={() => setMerge("")}>
          <GitMerge className="size-3.5" /> Merge a branch…
        </Button>
        {dialog}
      </div>
    );
  const repo = trees[0].path;
  const mainBranch = trees[0].branch;
  const commitHref = (sha: string) =>
    `/projects/${encodeURIComponent(projectSlug)}/git/${sha}${app ? `?app=${encodeURIComponent(app)}` : ""}`;

  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          <GitBranch className="size-3.5" /> Worktrees ({trees.length})
        </h3>
        <Button size="sm" variant="outline" className="h-7" onClick={() => setMerge("")}>
          <GitMerge className="size-3.5" /> Merge a branch…
        </Button>
      </div>
      {dialog}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 font-medium">Worktree</th>
              <th className="px-2 py-1.5 font-medium">Agent</th>
              <th className="px-2 py-1.5 font-medium">Branch</th>
              <th className="px-2 py-1.5 font-medium">HEAD</th>
              <th className="px-2 py-1.5 font-medium">Changes</th>
              <th className="px-2 py-1.5 font-medium whitespace-nowrap" title={`Commits ahead / behind ${mainBranch ?? "the main checkout"}`}>
                Ahead / behind
              </th>
              <th className="px-2 py-1.5 font-medium">Last commit</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {trees.map((t) => (
              <tr key={t.path} className={`border-t ${t.missing ? "opacity-50" : ""}`}>
                <td className="max-w-56 px-2 py-1.5">
                  <span className="flex items-center gap-1.5" title={t.path}>
                    <span className="truncate font-mono">{shortPath(t.path, repo)}</span>
                    {t.main && <span className="shrink-0 rounded bg-muted px-1 text-[10px]">main checkout</span>}
                    {t.missing && <span className="shrink-0 rounded bg-muted px-1 text-[10px]">folder gone</span>}
                    {t.lockedBy && (
                      <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground" title={t.lockedBy}>
                        <Lock className="size-3" />
                        {/^claude session (\S+)/.exec(t.lockedBy)?.[1] ?? "locked"}
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-2 py-1.5 whitespace-nowrap">{t.agents.join(", ")}</td>
                <td className="px-2 py-1.5 font-mono whitespace-nowrap">{t.branch ?? (t.detached ? "(detached)" : "")}</td>
                <td className="px-2 py-1.5 font-mono">
                  {t.head && (
                    <Link href={commitHref(t.head)} className="hover:underline">
                      {t.head.slice(0, 7)}
                    </Link>
                  )}
                </td>
                <td className="px-2 py-1.5 whitespace-nowrap">
                  {t.changes == null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : t.changes === 0 ? (
                    <span className="text-muted-foreground">clean</span>
                  ) : (
                    <span className="font-medium text-amber-700 dark:text-amber-400">{t.changes} uncommitted</span>
                  )}
                </td>
                <td className="px-2 py-1.5 font-mono whitespace-nowrap tabular-nums">
                  {t.ahead == null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span title={`${t.ahead} ahead, ${t.behind} behind ${mainBranch}`}>
                      ↑{t.ahead} ↓{t.behind}
                    </span>
                  )}
                </td>
                <td className="max-w-56 px-2 py-1.5">
                  {t.lastCommit && (
                    <span className="flex gap-1.5" title={t.lastCommit.subject}>
                      <span className="shrink-0 text-muted-foreground">{formatRelativeTime(t.lastCommit.at)}</span>
                      <span className="truncate">{t.lastCommit.subject}</span>
                    </span>
                  )}
                </td>
                <td className="px-1 py-1">
                  {!t.main && t.branch && (t.ahead ?? 0) > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-xs"
                      onClick={() => setMerge(t.branch!)}
                      title={`Merge ${t.branch} into ${mainBranch} (preview first)`}
                    >
                      <GitMerge className="size-3" /> Merge
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
