"use client";

import { Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Finding, LiveReview, ReviewResult } from "@/lib/code-review";
import { cn } from "@/lib/utils";

/** A review's verdict, as the Git tab says it. */
export const VERDICT: Record<ReviewResult["verdict"], { label: string; className: string }> = {
  passed: { label: "passed", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  warned: { label: "warned", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  blocked: { label: "stopped", className: "bg-destructive/15 text-destructive" },
  overridden: { label: "skipped (REVIEW=skip)", className: "bg-muted text-muted-foreground" },
  timeout: { label: "timed out, let through", className: "bg-muted text-muted-foreground" },
  error: { label: "not reviewed", className: "bg-muted text-muted-foreground" },
};

/** A review's findings: each one's severity, where, what, and the failure it means. */
export function Findings({ findings }: { findings: Finding[] }) {
  return (
    <>
      {findings.map((f, i) => (
        <div key={i} className="rounded border p-1.5">
          <div className="flex items-center gap-2">
            <Badge variant={f.severity === "high" ? "destructive" : "secondary"}>{f.severity}</Badge>
            <span className="font-mono">
              {f.file}
              {f.line ? `:${f.line}` : ""}
            </span>
            <span className="font-medium">{f.title}</span>
          </div>
          <p className="mt-1 whitespace-pre-line text-muted-foreground">{f.detail}</p>
        </div>
      ))}
    </>
  );
}

/** "1:05", from seconds. */
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The time now, every second while `on`. */
function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

/** How many steps of Claude's show (the latest). */
const STEPS_SHOWN = 8;

/**
 * A review before push as it goes (`live`, the hook's progress: where it's at, the commits and the diff it's looking
 * at, what Claude has read and searched so far, the time it's taken against its limit) or, once it's done (`result`),
 * its verdict, summary and findings.
 */
export function ReviewProgress({ live, result }: { live?: LiveReview | null; result?: ReviewResult | null }) {
  const now = useNow(!!live && !result);
  if (result) {
    const v = VERDICT[result.verdict];
    return (
      <div className="space-y-1.5 text-xs" data-testid="review-result">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">Review before push</span>
          <span className={cn("rounded px-1.5", v.className)}>{v.label}</span>
          <span className="ml-auto shrink-0 text-muted-foreground">
            {(result.durationMs / 1000).toFixed(0)} s{result.cached ? " · reviewed before" : ""}
            {result.costUsd != null ? ` · $${result.costUsd.toFixed(3)}` : ""}
          </span>
        </div>
        {result.summary && <p>{result.summary}</p>}
        {result.note && <p className="text-muted-foreground">{result.note}</p>}
        <Findings findings={result.findings} />
      </div>
    );
  }
  if (!live) return null;
  const n = live.commits.length;
  const since = Date.parse(live.reviewingSince ?? live.at);
  const elapsed = Math.max(0, (now - since) / 1000);
  const what =
    live.phase === "preparing"
      ? "Looking at what the push adds…"
      : live.phase === "waiting"
        ? "Waiting for a free review slot: two other reviews are running…"
        : `Claude is reviewing ${n} commit${n === 1 ? "" : "s"} on ${live.branch}`;
  const earlier = Math.max(0, live.steps.length - STEPS_SHOWN);
  return (
    <div className="space-y-1.5 text-xs" data-testid="review-live">
      <div className="flex items-center gap-2">
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        <span className="font-medium">{what}</span>
        <span className="ml-auto shrink-0 text-muted-foreground tabular-nums" title={`It gives up at ${clock(live.timeoutSec)} and lets the push through`}>
          {clock(elapsed)} / {clock(live.timeoutSec)}
        </span>
      </div>
      {live.files > 0 && (
        <p className="text-muted-foreground">
          {live.files} file{live.files === 1 ? "" : "s"}, <span className="text-emerald-700 dark:text-emerald-400">+{live.added}</span>{" "}
          <span className="text-destructive">−{live.removed}</span>
          {live.truncated ? " (the diff is cut short for size)" : ""} · {live.effort === "low" ? "a quick look" : live.effort === "high" ? "a thorough look" : "a normal look"}
          {live.pusher === "agent" ? " · an agent's push" : ""}
        </p>
      )}
      {n > 0 && (
        <ul className="space-y-0.5 border-l pl-2 text-muted-foreground">
          {live.commits.slice(0, 3).map((c, i) => (
            <li key={i} className="truncate">
              {c}
            </li>
          ))}
          {n > 3 && <li>and {n - 3} more</li>}
        </ul>
      )}
      {live.steps.length > 0 && (
        <ol className="space-y-0.5 rounded bg-muted/40 px-2 py-1.5 font-mono text-[11px]">
          {earlier > 0 && <li className="text-muted-foreground">{earlier} earlier step{earlier === 1 ? "" : "s"}</li>}
          {live.steps.slice(-STEPS_SHOWN).map((s, i, shown) => (
            <li key={`${s.at}-${i}`} className={cn("flex gap-2", i < shown.length - 1 && "text-muted-foreground")}>
              <span className="min-w-0 flex-1 truncate" title={s.text}>
                {s.text}
              </span>
              <span className="shrink-0 tabular-nums opacity-60">{clock(Math.max(0, (Date.parse(s.at) - since) / 1000))}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** What to do about a review that stopped a push. */
export function StoppedHint() {
  return (
    <p className="text-xs text-muted-foreground">
      Fix them and push again. If they&apos;re wrong, <code>REVIEW=skip git push</code> from a terminal gets past the review, and is noted.
    </p>
  );
}

/**
 * A push's review before push in a dialog: followed while it runs, then its result (`outcome`: what became of the push).
 * Closing it doesn't stop the push.
 */
export function PushReviewDialog({
  branch,
  live,
  result,
  outcome,
  onClose,
}: {
  branch: string;
  live: LiveReview | null;
  result: ReviewResult | null;
  outcome: { title: string; text: string } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{outcome ? outcome.title : `Pushing ${branch}`}</DialogTitle>
          <DialogDescription>
            {outcome ? outcome.text : "The review before push runs first, and the push goes once it's done. Closing this doesn't stop it."}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          <ReviewProgress live={live} result={result} />
        </div>
        {result?.verdict === "blocked" && <StoppedHint />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
