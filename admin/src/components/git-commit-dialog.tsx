"use client";

import { GitCommitHorizontal, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { PushReviewDialog, ReviewProgress, VERDICT } from "@/components/review-progress";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { LiveReview, ReviewResult } from "@/lib/code-review";
import { BASE_PATH } from "@/lib/config";
import type { GitStatusFile, GitSync } from "@/lib/git-graph";
import { readPush } from "@/lib/push-client";

/** A status code in words, for the file list's tooltip. */
function codeLabel(code: string): string {
  if (code === "??") return "untracked (new)";
  const c = code.trim()[0];
  return { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "conflicted", T: "type changed" }[c] ?? code;
}

/**
 * Commit the checkout's changes from the Git tab: tick the files (all at
 * first), write the message, Commit, or Commit & push to origin. A push's
 * review before push shows here as it goes, and its result after, in place of
 * the form, when it found something.
 */
export function GitCommitDialog({
  projectSlug,
  app,
  view,
  checkout,
  files,
  sync,
  onClose,
  onDone,
}: {
  projectSlug: string;
  app: string;
  /** the Git tab's view ("all", "branch:…", "wt:…"): the server finds the checkout from it */
  view: string;
  checkout: string;
  files: GitStatusFile[];
  sync: GitSync | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(files.map((f) => f.path)));
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"commit" | "push" | null>(null);
  const all = picked.size === files.length;
  const canPush = !!sync?.origin;
  const [live, setLive] = useState<LiveReview | null>(null);
  const [after, setAfter] = useState<{ result: ReviewResult; outcome: { title: string; text: string } } | null>(null);

  async function submit(push: boolean) {
    setBusy(push ? "push" : "commit");
    try {
      const r = await fetch(`${BASE_PATH}/api/git/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: projectSlug,
          app,
          view: view === "all" ? "" : view,
          message,
          paths: files.filter((f) => picked.has(f.path)).map((f) => f.path),
          push,
        }),
      });
      const j = await readPush<{ sha: string; files: number; pushError?: string; push?: { branch: string } }>(r, setLive);
      if (typeof j.error === "string") throw new Error(j.error);
      const what = `Committed ${String(j.sha).slice(0, 7)} (${j.files} file${j.files === 1 ? "" : "s"})`;
      const review = j.review ?? null;
      // (stopped by the review: its findings say why, better than git's lines)
      const pushError = review?.verdict === "blocked" ? "the review before push stopped it" : j.pushError;
      if (pushError) toast.warning(`${what}, but the push failed: ${pushError}`, { duration: 15_000 });
      else toast.success(j.push ? `${what} and pushed to origin/${j.push.branch}${review ? ` · review ${VERDICT[review.verdict].label}` : ""}` : what);
      onDone();
      if (review && (review.findings.length > 0 || review.verdict !== "passed")) {
        setAfter({
          result: review,
          outcome: pushError
            ? { title: "Committed, not pushed", text: `${what}; the push failed: ${pushError}` }
            : { title: "Committed and pushed", text: `${what}, pushed to origin/${j.push?.branch}` },
        });
      } else onClose();
    } catch (e) {
      toast.error(`Not committed: ${e instanceof Error ? e.message : String(e)}`, { duration: 15_000 });
    } finally {
      setBusy(null);
      setLive(null);
    }
  }

  const ready = picked.size > 0 && message.trim().length > 0 && !busy;
  if (after) return <PushReviewDialog branch={sync?.branch ?? ""} live={null} result={after.result} outcome={after.outcome} onClose={onClose} />;

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCommitHorizontal className="size-4" /> Commit
            {sync && <span className="font-mono text-sm font-normal text-muted-foreground">on {sync.branch}</span>}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">{checkout}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="overflow-hidden rounded-md border">
            <label className="flex items-center gap-2 border-b bg-muted/40 px-2 py-1.5 text-xs">
              <Checkbox
                checked={all}
                indeterminate={!all && picked.size > 0}
                onCheckedChange={() => setPicked(all ? new Set() : new Set(files.map((f) => f.path)))}
                aria-label="All files"
              />
              <span className="text-muted-foreground">
                {picked.size} of {files.length} file{files.length === 1 ? "" : "s"}
              </span>
            </label>
            <ul className="max-h-64 overflow-y-auto py-1 font-mono text-xs">
              {files.map((f) => (
                <li key={f.path}>
                  <label className="flex cursor-pointer items-center gap-2 px-2 py-0.5 hover:bg-muted/60" title={codeLabel(f.code)}>
                    <Checkbox
                      checked={picked.has(f.path)}
                      onCheckedChange={(on) =>
                        setPicked((s) => {
                          const next = new Set(s);
                          if (on) next.add(f.path);
                          else next.delete(f.path);
                          return next;
                        })
                      }
                      aria-label={f.path}
                    />
                    <span className="w-5 shrink-0 text-muted-foreground">{f.code.trim() || f.code}</span>
                    <span className="min-w-0 truncate" dir="rtl">
                      <bdi>{f.from ? `${f.from} → ${f.path}` : f.path}</bdi>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>

          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Commit message (first line: the summary)"
            aria-label="Commit message"
            rows={4}
            autoFocus
            className="font-mono text-xs md:text-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && ready) {
                e.preventDefault();
                void submit(false);
              }
            }}
          />
          {sync && sync.behind > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              origin/{sync.branch} has {sync.behind} commit{sync.behind === 1 ? "" : "s"} this branch lacks: a push will be
              refused until you pull them.
            </p>
          )}
          {busy === "push" && live && (
            <div className="max-h-72 overflow-y-auto rounded-md border p-2">
              <ReviewProgress live={live} />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={!!busy}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => void submit(false)} disabled={!ready}>
            <GitCommitHorizontal className="size-4" />
            {busy === "commit" ? "Committing…" : "Commit"}
          </Button>
          {canPush && sync && (
            <Button onClick={() => void submit(true)} disabled={!ready} title={`Commit, then push ${sync.branch} to origin/${sync.branch}`}>
              <Upload className="size-4" />
              {busy === "push" ? "Committing & pushing…" : "Commit & push"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
