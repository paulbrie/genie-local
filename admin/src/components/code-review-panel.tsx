"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ProjectReview, ReviewResult, ReviewSettings } from "@/lib/code-review";
import { BASE_PATH } from "@/lib/config";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const API = `${BASE_PATH}/api/code-review`;

const VERDICT: Record<ReviewResult["verdict"], { label: string; className: string }> = {
  passed: { label: "passed", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  warned: { label: "warned", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  blocked: { label: "stopped", className: "bg-destructive/15 text-destructive" },
  overridden: { label: "skipped (REVIEW=skip)", className: "bg-muted text-muted-foreground" },
  timeout: { label: "timed out, let through", className: "bg-muted text-muted-foreground" },
  error: { label: "not reviewed", className: "bg-muted text-muted-foreground" },
};

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

/**
 * Review before push, on a project's Git tab: Claude reviews what a push to the
 * chosen branches adds and stops it on serious findings (src/lib/code-review,
 * scripts/review-hook.mjs). The settings, each repo's hook, and the latest
 * reviews with their findings.
 */
export function CodeReviewPanel({ slug }: { slug: string }) {
  const [data, setData] = useState<ProjectReview | null>(null);
  const [draft, setDraft] = useState<ReviewSettings | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [shown, setShown] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`${API}?slug=${encodeURIComponent(slug)}`, { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return;
    const d: ProjectReview = await res.json();
    setData(d);
    setDraft((cur) => cur ?? d.settings);
  }, [slug]);
  useEffect(() => {
    // (off the mount tick, like the update button; then as pushes happen)
    const first = setTimeout(load, 0);
    const id = setInterval(load, 20_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [load]);

  const save = async (next: ReviewSettings) => {
    setSaving(true);
    try {
      const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, settings: next }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setData(body);
      setDraft(body.settings);
      toast.success(next.enabled ? "Review before push is on" : "Review before push is off");
    } catch (e) {
      toast.error(`Couldn't save: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  if (!data || !draft) return null;
  const s = data.settings;
  const last = data.results[0];
  const set = (patch: Partial<ReviewSettings>) => setDraft({ ...draft, ...patch });
  const dirty = JSON.stringify(draft) !== JSON.stringify(s);

  return (
    <section className="rounded-lg border" data-testid="code-review">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm" aria-expanded={open}>
        <ShieldCheck className={cn("size-4", s.enabled ? "text-emerald-600" : "text-muted-foreground")} />
        <span className="font-medium">Review before push</span>
        <span className="truncate text-muted-foreground">
          {s.enabled
            ? `on for ${s.branches.join(", ") || "no branch"} · stops at ${s.blockAt === "never" ? "nothing (warns only)" : `${s.blockAt} findings`} · ${s.who === "both" ? "everyone" : s.who}`
            : "off"}
        </span>
        {last && (
          <span className={cn("ml-auto shrink-0 rounded px-1.5 text-xs", VERDICT[last.verdict].className)}>
            last: {VERDICT[last.verdict].label} {formatRelativeTime(new Date(last.at))}
          </span>
        )}
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", !last && "ml-auto", open && "rotate-180")} />
      </button>

      {open && (
        <div className="space-y-4 border-t p-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Before a push to one of these branches leaves this server, Claude reviews what it adds (read-only) and prints its
            findings; at or past the chosen severity the push is stopped. If the review can&apos;t run (busy, timed out,
            Claude unavailable) the push goes through, noted. <code>REVIEW=skip git push</code> gets past it, and is noted too.
          </p>

          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save(draft);
            }}
          >
            <label className="flex items-center gap-2 sm:col-span-2">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
              Review pushes in this project
            </label>
            <label className="grid content-start gap-1">
              <span className="text-xs text-muted-foreground">Branches (one per line; * and ** globs, !pattern leaves one out)</span>
              <Textarea rows={3} value={draft.branches.join("\n")} onChange={(e) => set({ branches: lines(e.target.value) })} className="font-mono text-xs" />
            </label>
            <label className="grid content-start gap-1">
              <span className="text-xs text-muted-foreground">Files left out of the review</span>
              <Textarea rows={3} value={draft.skip.join("\n")} onChange={(e) => set({ skip: lines(e.target.value) })} className="font-mono text-xs" />
            </label>
            <label className="grid content-start gap-1">
              <span className="text-xs text-muted-foreground">Stop the push at</span>
              <select className="h-8 rounded-md border bg-background px-2" value={draft.blockAt} onChange={(e) => set({ blockAt: e.target.value as ReviewSettings["blockAt"] })}>
                <option value="high">high findings</option>
                <option value="medium">medium or worse</option>
                <option value="low">any finding</option>
                <option value="never">never (warn only)</option>
              </select>
            </label>
            <label className="grid content-start gap-1">
              <span className="text-xs text-muted-foreground">Whose pushes</span>
              <select className="h-8 rounded-md border bg-background px-2" value={draft.who} onChange={(e) => set({ who: e.target.value as ReviewSettings["who"] })}>
                <option value="both">everyone</option>
                <option value="agents">agents only (Claude sessions)</option>
                <option value="people">people only</option>
              </select>
            </label>
            <label className="grid content-start gap-1">
              <span className="text-xs text-muted-foreground">How closely</span>
              <select className="h-8 rounded-md border bg-background px-2" value={draft.effort} onChange={(e) => set({ effort: e.target.value as ReviewSettings["effort"] })}>
                <option value="low">quick</option>
                <option value="medium">normal</option>
                <option value="high">thorough (slower, costs more)</option>
              </select>
            </label>
            <label className="grid content-start gap-1">
              <span className="text-xs text-muted-foreground">Give up after (seconds), and let the push through</span>
              <Input type="number" min={30} max={1800} value={draft.timeoutSec} onChange={(e) => set({ timeoutSec: Number(e.target.value) || 240 })} className="h-8" />
            </label>
            <div className="flex items-center gap-2 sm:col-span-2">
              <Button size="sm" type="submit" disabled={saving || !dirty}>
                Save
              </Button>
              {dirty && (
                <Button size="sm" variant="ghost" type="button" onClick={() => setDraft(s)}>
                  Undo changes
                </Button>
              )}
            </div>
          </form>

          {s.enabled && (
            <div className="space-y-1">
              <h4 className="text-xs font-medium text-muted-foreground">Hooks</h4>
              {data.hooks.map((h) => (
                <div key={h.repo} className="text-xs">
                  <span className="font-mono">{h.repo}</span>{" "}
                  {h.state === "installed" ? (
                    <span className="text-emerald-700 dark:text-emerald-400">installed{h.chained ? " (its own pre-push hook runs first)" : ""}</span>
                  ) : h.state === "missing" ? (
                    <span className="text-amber-700 dark:text-amber-400">missing: save again to put it back</span>
                  ) : (
                    <span className="text-amber-700 dark:text-amber-400">
                      by hand: {h.why}
                      <code className="mt-1 block rounded bg-muted p-1 break-all text-foreground">{h.line}</code>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="space-y-1">
            <h4 className="text-xs font-medium text-muted-foreground">Latest reviews</h4>
            {data.results.length === 0 && <p className="text-xs text-muted-foreground">None yet.</p>}
            <ul className="divide-y rounded border">
              {data.results.map((r) => (
                <li key={r.id} className="px-2 py-1.5">
                  <button type="button" className="flex w-full items-center gap-2 text-left text-xs" onClick={() => setShown(shown === r.id ? null : r.id)}>
                    <span className={cn("shrink-0 rounded px-1.5", VERDICT[r.verdict].className)}>{VERDICT[r.verdict].label}</span>
                    <span className="font-mono">{r.branch}</span>
                    <span className="truncate text-muted-foreground">{r.commits[0] ?? r.head.slice(0, 8)}{r.commits.length > 1 ? ` (+${r.commits.length - 1})` : ""}</span>
                    <span className="ml-auto shrink-0 text-muted-foreground">
                      {r.findings.length ? `${r.findings.length} finding${r.findings.length === 1 ? "" : "s"} · ` : ""}
                      {r.pusher} · {formatRelativeTime(new Date(r.at))}
                    </span>
                  </button>
                  {shown === r.id && (
                    <div className="mt-1 space-y-1 pl-2 text-xs">
                      {r.summary && <p>{r.summary}</p>}
                      {r.note && <p className="text-muted-foreground">{r.note}</p>}
                      {r.findings.map((f, i) => (
                        <div key={i} className="rounded border p-1.5">
                          <div className="flex items-center gap-2">
                            <Badge variant={f.severity === "high" ? "destructive" : "secondary"}>{f.severity}</Badge>
                            <span className="font-mono">{f.file}{f.line ? `:${f.line}` : ""}</span>
                            <span className="font-medium">{f.title}</span>
                          </div>
                          <p className="mt-1 whitespace-pre-line text-muted-foreground">{f.detail}</p>
                        </div>
                      ))}
                      <p className="text-muted-foreground">
                        {r.base ? `${r.base.slice(0, 8)}..` : ""}{r.head.slice(0, 8)} · {(r.durationMs / 1000).toFixed(1)} s{r.cached ? " · reviewed before" : ""}{r.costUsd != null ? ` · $${r.costUsd.toFixed(3)}` : ""}
                      </p>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
