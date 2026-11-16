"use client";

import { GitBranch, GitMerge, Loader2, Lock, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { GitMergeDialog } from "@/components/git-merge-dialog";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { confirmDialog } from "@/lib/ask";
import { BASE_PATH } from "@/lib/config";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import type { Worktree } from "@/lib/worktrees";

/** "/home/genie/bob-scratch/trafficsim-wt" → "~/bob-scratch/trafficsim-wt"; a worktree inside the repo → its relative path. */
function shortPath(p: string, repo: string): string {
  if (p === repo) return ".";
  if (p.startsWith(repo + "/")) return p.slice(repo.length + 1);
  return p.replace(/^\/home\/[^/]+/, "~");
}

/**
 * The repo's worktrees (where agents work on their own branches): the room each
 * takes on disk, branch, HEAD, uncommitted changes, ahead / behind the main
 * checkout, last commit, and the terminals working in each. A worktree's
 * right-click deletes it (not the main checkout's); its branch stays.
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
  // the room each takes (du, asked for after the list: it can take a while), by path; null meanwhile
  const [sizes, setSizes] = useState<Record<string, number | null> | null>(null);
  // the one being deleted (a big one takes a moment)
  const [deleting, setDeleting] = useState<string | null>(null);

  const query = `project=${encodeURIComponent(projectSlug)}&app=${encodeURIComponent(app)}`;
  useEffect(() => {
    let active = true;
    fetch(`${BASE_PATH}/api/git/worktrees?${query}&sizes=1`, { cache: "no-store" })
      .then(async (r) => {
        const json = (await r.json()) as { sizes?: Record<string, number | null> };
        if (active) setSizes(r.ok ? (json.sizes ?? {}) : {});
      })
      .catch(() => active && setSizes({}));
    return () => {
      active = false;
    };
  }, [query, reload, refreshKey]);

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

  // Delete a worktree (its right-click): asked first; uncommitted work in it, or a lock on it, asked about again, then forced.
  const remove = async (t: Worktree) => {
    const name = shortPath(t.path, repo);
    const size = sizes?.[t.path];
    const working = t.agents.length ? ` ${t.agents.join(", ")} ${t.agents.length === 1 ? "is" : "are"} working in it.` : "";
    if (
      !(await confirmDialog(
        `Its folder${size != null ? ` (${formatBytes(size)})` : ""} goes, with everything in it${t.branch ? `; its branch ${t.branch} stays` : ""}.${working}`,
        { title: `Delete the worktree ${name}?`, confirmLabel: "Delete", destructive: true },
      ))
    )
      return;
    const del = async (force: boolean) => {
      const r = await fetch(`${BASE_PATH}/api/git/worktrees`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: projectSlug, app, path: t.path, force }),
      });
      const j = (await r.json()) as { removed?: boolean; branch?: string | null; changes?: number; lockedBy?: string | null; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      return j;
    };
    setDeleting(t.path);
    try {
      let j = await del(false);
      if (!j.removed) {
        const n = j.changes ?? 0;
        const why = [
          n ? `${n} uncommitted change${n === 1 ? " in it is" : "s in it are"} lost with it.` : "",
          j.lockedBy ? `It's locked (${j.lockedBy}): an agent may still be working in it.` : "",
        ].filter(Boolean);
        if (!(await confirmDialog(why.join(" "), { title: `${name} isn't clean`, confirmLabel: "Delete anyway", destructive: true }))) return;
        j = await del(true);
      }
      toast.success(`Deleted the worktree ${name}${j.branch ? ` (its branch ${j.branch} stays)` : ""}`);
      setReload((k) => k + 1);
    } catch (e) {
      toast.error(`Not deleted: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeleting(null);
    }
  };

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
              <th className="px-2 py-1.5 text-right font-medium" title="On disk, less the worktrees inside it; the main checkout's counts .git, the history they all share">
                Size
              </th>
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
              <ContextMenu key={t.path}>
                <ContextMenuTrigger render={<tr />} className={`border-t ${t.missing || deleting === t.path ? "opacity-50" : ""}`}>
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
                  <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums text-muted-foreground">
                    {deleting === t.path ? (
                      <span className="inline-flex items-center gap-1">
                        <Loader2 className="size-3 animate-spin" /> deleting
                      </span>
                    ) : sizes ? (
                      formatBytes(sizes[t.path])
                    ) : (
                      <Loader2 className="inline size-3 animate-spin" aria-label="Measuring" />
                    )}
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
                </ContextMenuTrigger>
                <ContextMenuContent className="w-60">
                  <ContextMenuLabel className="truncate font-mono" title={t.path}>
                    {shortPath(t.path, repo)}
                  </ContextMenuLabel>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" disabled={t.main || !!deleting} onClick={() => void remove(t)}>
                    <Trash2 /> {t.main ? "The main checkout stays" : "Delete…"}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
