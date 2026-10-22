"use client";

import { AlertTriangle, GitMerge, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BASE_PATH } from "@/lib/config";
import { formatRelativeTime } from "@/lib/format";
import type { MergeCandidate, MergePreview } from "@/lib/git-merge";

const API = `${BASE_PATH}/api/git/merge`;

/**
 * Merge a local branch into the main checkout's branch, locally. Picks the
 * branch (the ones ahead), shows what it brings (commits, files) and whether it
 * fast-forwards, conflicts, or is blocked by uncommitted work in the checkout,
 * and only then merges.
 */
export function GitMergeDialog({
  projectSlug,
  app,
  initialBranch,
  onClose,
  onMerged,
}: {
  projectSlug: string;
  app: string;
  initialBranch: string | null;
  onClose: () => void;
  onMerged: () => void;
}) {
  const q = `project=${encodeURIComponent(projectSlug)}&app=${encodeURIComponent(app)}`;
  const [list, setList] = useState<{ target: string; candidates: MergeCandidate[] } | null>(null);
  const [branch, setBranch] = useState<string | null>(initialBranch);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    fetch(`${API}?${q}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        setList(j);
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, [q]);

  useEffect(() => {
    if (!branch) return;
    let active = true;
    fetch(`${API}?${q}&branch=${encodeURIComponent(branch)}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        if (active) setPreview(j);
      })
      .catch((e) => active && setError(String(e instanceof Error ? e.message : e)));
    return () => {
      active = false;
    };
  }, [q, branch]);

  const pick = (b: string) => {
    setPreview(null);
    setError(null);
    setBranch(b);
  };

  async function merge() {
    if (!preview) return;
    setMerging(true);
    try {
      const r = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: projectSlug, app, branch: preview.branch, expectHead: preview.targetHead }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      toast.success(
        `${preview.branch} merged into ${preview.target} (${j.fastForward ? "fast-forward" : "merge commit"} ${String(j.head).slice(0, 7)})`,
      );
      onMerged();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setMerging(false);
    }
  }

  const blocked = !preview || preview.commits.length === 0 || preview.conflicts.length > 0 || preview.blockedBy.length > 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="size-4" /> Merge into {list?.target ?? preview?.target ?? "…"}
          </DialogTitle>
          <DialogDescription>
            A local merge, in the repo&apos;s main checkout. Nothing is pushed.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto text-sm">
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">Branch</span>
            <select
              value={branch ?? ""}
              onChange={(e) => pick(e.target.value)}
              aria-label="Branch to merge"
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-xs"
            >
              <option value="" disabled>
                {list ? (list.candidates.length ? "Pick a branch…" : "No branch is ahead") : "Loading…"}
              </option>
              {/* the branch asked for, even before the list arrives */}
              {branch && !list?.candidates.some((c) => c.branch === branch) && <option value={branch}>{branch}</option>}
              {list?.candidates.map((c) => (
                <option key={c.branch} value={c.branch}>
                  {c.branch} · ↑{c.ahead} ↓{c.behind}
                  {c.lastCommit ? ` · ${formatRelativeTime(c.lastCommit)}` : ""}
                </option>
              ))}
            </select>
          </label>

          {error && <p className="text-destructive">{error}</p>}
          {branch && !preview && !error && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Checking the merge…
            </p>
          )}

          {preview && (
            <>
              {preview.conflicts.length > 0 ? (
                <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs">
                  <p className="flex items-center gap-1.5 font-medium text-red-700 dark:text-red-400">
                    <AlertTriangle className="size-3.5" /> Conflicts in {preview.conflicts.length} file
                    {preview.conflicts.length === 1 ? "" : "s"}: merge it by hand
                  </p>
                  <ul className="mt-1 font-mono">{preview.conflicts.map((f) => <li key={f}>{f}</li>)}</ul>
                </div>
              ) : preview.blockedBy.length > 0 ? (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                  <p className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-300">
                    <AlertTriangle className="size-3.5" /> Uncommitted changes in the main checkout would be overwritten
                  </p>
                  <ul className="mt-1 font-mono">{preview.blockedBy.map((f) => <li key={f}>{f}</li>)}</ul>
                  <p className="mt-1">Commit or stash them there first.</p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Merges cleanly:{" "}
                  {preview.fastForward ? "a fast-forward (no merge commit)." : "a merge commit on top of " + preview.target + "."}
                </p>
              )}

              <section>
                <h4 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {preview.commits.length} commit{preview.commits.length === 1 ? "" : "s"}
                </h4>
                <ul className="divide-y rounded-md border text-xs">
                  {preview.commits.map((c) => (
                    <li key={c.sha} className="flex gap-2 px-2 py-1">
                      <span className="font-mono text-muted-foreground">{c.sha}</span>
                      <span className="min-w-0 flex-1 truncate" title={c.subject}>{c.subject}</span>
                      <span className="shrink-0 text-muted-foreground">{c.author} · {formatRelativeTime(c.at)}</span>
                    </li>
                  ))}
                </ul>
              </section>
              <section>
                <h4 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {preview.files.length} file{preview.files.length === 1 ? "" : "s"} changed
                </h4>
                <ul className="max-h-40 overflow-y-auto rounded-md border px-2 py-1 font-mono text-xs">
                  {preview.files.map((f) => (
                    <li key={f.path}>
                      <span className="inline-block w-5 text-muted-foreground">{f.status[0]}</span>
                      {f.path}
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void merge()} disabled={blocked || merging}>
            <GitMerge className="size-4" />
            {merging
              ? "Merging…"
              : preview
                ? `Merge ${preview.commits.length} commit${preview.commits.length === 1 ? "" : "s"} into ${preview.target}`
                : "Merge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
