"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRightLeft, FolderGit2, GitBranch, GitCommitHorizontal, RefreshCw, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { GitCommitDialog } from "@/components/git-commit-dialog";
import { GitWorktrees } from "@/components/git-worktrees";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BASE_PATH } from "@/lib/config";
import { formatRelativeTime } from "@/lib/format";
import type { GitGraph, GitRepo, GraphRow, GraphViews } from "@/lib/git-graph";
import { confirmDialog } from "@/lib/ask";

// Lane colours — mid-saturation so they read on both light and dark themes.
const PALETTE = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#a855f7",
  "#f59e0b",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
  "#f97316",
  "#14b8a6",
];
const color = (i: number) => PALETTE[i % PALETTE.length];

const ROW_H = 30;
const COL_W = 16;
const DOT_R = 4;
const PAD_X = 10;

type GitResponse = { repos: GitRepo[]; app: string; graph: GitGraph; views: GraphViews };

/** The view picker's value: "all", "branch:<name>" or "wt:<path>" (as the API takes it). */
const ALL = "all";
const viewOf = (g: GitGraph) =>
  g.view.kind === "branch" ? `branch:${g.view.branch}` : g.view.kind === "worktree" ? `wt:${g.view.path}` : ALL;
// last two segments: agents' worktrees share folder names (alex-scratch/trafficsim-wt, bob-scratch/…)
const folder = (p: string) => p.split("/").filter(Boolean).slice(-2).join("/") || p;

async function fetchGraph(projectSlug: string, app: string, view = ALL): Promise<GitResponse> {
  const url = `${BASE_PATH}/api/git?project=${encodeURIComponent(
    projectSlug,
  )}&app=${encodeURIComponent(app)}${view !== ALL ? `&view=${encodeURIComponent(view)}` : ""}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as GitResponse;
}

/** The view asked for, or all branches (with a toast) when that branch / worktree is gone. */
async function fetchGraphOrAll(projectSlug: string, app: string, view: string): Promise<GitResponse> {
  if (view === ALL) return fetchGraph(projectSlug, app);
  try {
    return await fetchGraph(projectSlug, app, view);
  } catch (e) {
    toast.warning(`${e instanceof Error ? e.message : String(e)}: showing all branches`);
    return fetchGraph(projectSlug, app);
  }
}

/**
 * A repo's history as a lane graph. Each commit links to its own page
 * (/projects/<slug>/git/<hash>), where the diff gets the whole window.
 */
export function GitGraphView({
  projectSlug,
  initialApp,
  initialView,
}: {
  projectSlug: string;
  initialApp?: string;
  /** "branch:<name>" or "wt:<path>"; all branches by default */
  initialView?: string;
}) {
  const router = useRouter();
  const [app, setApp] = useState(initialApp ?? "");
  const [data, setData] = useState<GitResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const showGraph = useCallback((json: GitResponse) => {
    setData(json);
    setApp(json.app);
    setLoading(false);
  }, []);

  const graphFailed = useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
    setData(null);
    setLoading(false);
  }, []);

  const view = data ? viewOf(data.graph) : initialView || ALL;

  // The repo picker: reload with the spinner.
  // Refresh: fetch from the remote (remote-tracking refs only), then re-read
  // the history and the worktrees in place.
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = async () => {
    setRefreshing(true);
    let note = "Refreshed";
    try {
      const r = await fetch(`${BASE_PATH}/api/git/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: projectSlug, app }),
      });
      const j = (await r.json()) as { fetched?: boolean; reason?: string; error?: string };
      note = j.fetched ? "Fetched from the remote and refreshed" : `Refreshed (no fetch: ${j.reason ?? j.error ?? "failed"})`;
    } catch {
      note = "Refreshed (the fetch failed)";
    }
    try {
      showGraph(await fetchGraphOrAll(projectSlug, app, view));
      setRefreshKey((k) => k + 1);
      toast.success(note);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  // The repo picker (back to all branches) and the branch / worktree picker.
  // Commit (a dialog) and Push, in the checkout the view shows; then re-read in place.
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const reread = async () => {
    try {
      showGraph(await fetchGraphOrAll(projectSlug, app, view));
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const push = async () => {
    setPushing(true);
    try {
      const r = await fetch(`${BASE_PATH}/api/git/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: projectSlug, app, view: view === ALL ? "" : view }),
      });
      const j = (await r.json()) as { branch?: string; pushed?: number; created?: boolean; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      toast.success(
        `Pushed ${j.pushed} commit${j.pushed === 1 ? "" : "s"} to origin/${j.branch}${j.created ? " (new on origin)" : ""}`,
      );
      await reread();
    } catch (e) {
      toast.error(`Not pushed: ${e instanceof Error ? e.message : String(e)}`, { duration: 15_000 });
    } finally {
      setPushing(false);
    }
  };

  // Check out: switch the main checkout (and so its dev server) to the branch shown.
  const [switching, setSwitching] = useState(false);
  const checkout = async (branch: string, from: string | null, dir: string) => {
    if (
      !(await confirmDialog(
        "Its dev server reloads on the new branch, and agents working in that checkout will be on it too.",
        { title: `Switch ${dir} from ${from ?? "a detached HEAD"} to ${branch}?`, confirmLabel: "Switch" },
      ))
    )
      return;
    setSwitching(true);
    try {
      const r = await fetch(`${BASE_PATH}/api/git/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: projectSlug, app, branch }),
      });
      const j = (await r.json()) as { head?: string; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      toast.success(`Checked out ${branch} (${String(j.head).slice(0, 7)})`);
      showGraph(await fetchGraphOrAll(projectSlug, app, `branch:${branch}`));
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast.error(`Not checked out: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSwitching(false);
    }
  };

  const load = (appSlug: string, nextView = ALL) => {
    setLoading(true);
    setError(null);
    // Keep the repo and view in the URL so the page (and its commit links) can be shared.
    const q = new URLSearchParams();
    if (appSlug) q.set("app", appSlug);
    if (nextView !== ALL) q.set("view", nextView);
    router.replace(`/projects/${encodeURIComponent(projectSlug)}/git${q.size ? `?${q}` : ""}`, { scroll: false });
    fetchGraphOrAll(projectSlug, appSlug, nextView).then(showGraph, graphFailed);
  };

  // First load: state starts out loading, so nothing is set until the fetch ends.
  useEffect(() => {
    let active = true;
    fetchGraphOrAll(projectSlug, initialApp ?? "", initialView || ALL).then(
      (json) => active && showGraph(json),
      (e) => active && graphFailed(e),
    );
    return () => {
      active = false;
    };
  }, [projectSlug, initialApp, initialView, showGraph, graphFailed]);

  if (loading)
    return <p className="text-sm text-muted-foreground">Loading history…</p>;
  if (error)
    return (
      <p className="text-sm text-destructive">
        Could not load git history: {error}
      </p>
    );
  if (!data) return null;

  const { repos, graph, views } = data;
  // The checkout the dev server runs from, and whether the branch shown is another one.
  const mainWt = views.worktrees.find((w) => w.main);
  const canCheckout =
    graph.view.kind === "branch" &&
    !!mainWt &&
    mainWt.branch !== graph.view.branch &&
    !views.worktrees.some((w) => w.branch === (graph.view as { branch: string }).branch);
  const svgWidth = PAD_X * 2 + Math.max(graph.columns, 1) * COL_W;
  const svgHeight = Math.max(graph.rows.length * ROW_H, ROW_H);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* Switch the history (and the uncommitted count) to a branch or worktree; nothing is checked out. */}
        <Select value={view} onValueChange={(v) => load(app, v ?? ALL)}>
          <SelectTrigger className="h-8 max-w-[320px] font-mono text-xs" aria-label="Branch or worktree shown">
            <SelectValue>
              {(v: string) =>
                v === ALL ? (
                  "All branches"
                ) : v.startsWith("branch:") ? (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <GitBranch className="size-3.5 shrink-0" />
                    <span className="truncate">{v.slice(7)}</span>
                  </span>
                ) : (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <FolderGit2 className="size-3.5 shrink-0" />
                    <span className="truncate">{folder(v.slice(3))}</span>
                  </span>
                )
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="max-h-96 w-auto min-w-(--anchor-width)">
            <SelectItem value={ALL}>All branches</SelectItem>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Local branches</SelectLabel>
              {views.branches.map((b) => (
                <SelectItem key={b} value={`branch:${b}`} className="font-mono text-xs">
                  <GitBranch className="size-3.5" />
                  {b}
                </SelectItem>
              ))}
            </SelectGroup>
            {views.worktrees.length > 1 && (
              <>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel>Worktrees</SelectLabel>
                  {views.worktrees.map((w) => (
                    <SelectItem key={w.path} value={`wt:${w.path}`} className="text-xs" title={w.path}>
                      <FolderGit2 className="size-3.5" />
                      <span className="font-mono">{w.main ? "main checkout" : folder(w.path)}</span>
                      <span className="text-muted-foreground">{w.branch ?? "detached"}</span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </>
            )}
          </SelectContent>
        </Select>
        {graph.branch && graph.view.kind !== "branch" && <Badge variant="secondary">{graph.branch}</Badge>}
        {canCheckout && graph.view.kind === "branch" && mainWt && (
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={switching}
            onClick={() => void checkout((graph.view as { branch: string }).branch, mainWt.branch, mainWt.path)}
            title={`git switch the main checkout (${mainWt.path}, now on ${mainWt.branch ?? "a detached HEAD"}) to this branch: its dev server follows`}
          >
            <ArrowRightLeft className="size-3.5" />
            {switching ? "Checking out…" : "Check out"}
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {graph.rows.length} commit{graph.rows.length === 1 ? "" : "s"}
          {graph.truncated && " (latest 200)"}
        </span>
        {graph.status.length > 0 && (
          <Badge variant="destructive" title={graph.status.map((f) => `${f.code} ${f.path}`).join("\n")}>
            {graph.status.length} uncommitted
          </Badge>
        )}
        {graph.checkout && graph.status.length > 0 && (
          <Button size="sm" variant="outline" className="h-8" onClick={() => setCommitting(true)} title={`Commit in ${graph.checkout}`}>
            <GitCommitHorizontal className="size-3.5" />
            Commit…
          </Button>
        )}
        {graph.sync?.origin && graph.sync.ahead > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={pushing}
            onClick={() => void push()}
            title={
              `git push ${graph.sync.branch} to origin/${graph.sync.branch}` +
              (graph.sync.onOrigin ? "" : " (new there)") +
              (graph.sync.behind > 0 ? ` — origin has ${graph.sync.behind} commit(s) this branch lacks: git will refuse until you pull` : "")
            }
          >
            <Upload className="size-3.5" />
            {pushing ? "Pushing…" : `Push ↑${graph.sync.ahead}`}
          </Button>
        )}
        {committing && graph.checkout && (
          <GitCommitDialog
            projectSlug={projectSlug}
            app={app}
            view={view}
            checkout={graph.checkout}
            files={graph.status}
            sync={graph.sync}
            onClose={() => setCommitting(false)}
            onDone={() => void reread()}
          />
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => void refresh()}
            disabled={refreshing}
            title="git fetch from the remote (remote branches only), then reload the history and worktrees"
          >
            <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
          {repos.length > 1 && (
            <Select value={app} onValueChange={(v) => load(v ?? "")}>
              <SelectTrigger className="h-8 w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {repos.map((r) => (
                  <SelectItem key={r.app} value={r.app}>
                    {r.app === "" ? "(root)" : r.app}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {/* Where agents work: one worktree each, on their own branch. */}
      <GitWorktrees projectSlug={projectSlug} app={app} refreshKey={refreshKey} onMerged={() => load(app)} />

      {/* Graph + commit list */}
      <ScrollArea className="max-h-[75vh] rounded-md border">
        <div className="flex">
          <svg
            width={svgWidth}
            height={svgHeight}
            className="shrink-0"
            style={{ minWidth: svgWidth }}
          >
            {graph.rows.map((row, i) =>
              row.edgesAbove.map((e, j) => {
                const x1 = PAD_X + e.top * COL_W;
                const x2 = PAD_X + e.bottom * COL_W;
                const y1 = (i - 1) * ROW_H + ROW_H / 2;
                const y2 = i * ROW_H + ROW_H / 2;
                const ym = (y1 + y2) / 2;
                return (
                  <path
                    key={`e-${i}-${j}`}
                    d={`M ${x1} ${y1} C ${x1} ${ym}, ${x2} ${ym}, ${x2} ${y2}`}
                    fill="none"
                    stroke={color(e.color)}
                    strokeWidth={1.5}
                  />
                );
              }),
            )}
            {graph.rows.map((row, i) => (
              <circle
                key={`d-${row.commit.hash}`}
                cx={PAD_X + row.column * COL_W}
                cy={i * ROW_H + ROW_H / 2}
                r={DOT_R}
                fill={color(row.color)}
                stroke="var(--background)"
                strokeWidth={1.5}
              />
            ))}
          </svg>

          <ul className="min-w-0 flex-1">
            {graph.rows.map((row) => (
              <CommitRow
                key={row.commit.hash}
                row={row}
                href={`/projects/${encodeURIComponent(projectSlug)}/git/${row.commit.hash}${
                  app ? `?app=${encodeURIComponent(app)}` : ""
                }`}
              />
            ))}
          </ul>
        </div>
      </ScrollArea>
    </div>
  );
}

function CommitRow({ row, href }: { row: GraphRow; href: string }) {
  const { commit } = row;
  return (
    <li id={`commit-${commit.hash}`} style={{ height: ROW_H }}>
      <Link
        href={href}
        className="flex h-full w-full items-center gap-2 px-2 text-left text-sm hover:bg-muted/60"
      >
        {commit.refs.map((ref) => (
          <Badge
            key={ref.name}
            variant={
              ref.kind === "tag"
                ? "outline"
                : ref.kind === "head"
                  ? "default"
                  : "secondary"
            }
            className="shrink-0"
          >
            {ref.name}
          </Badge>
        ))}
        <span className="truncate">{commit.subject}</span>
        <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
          {commit.abbrev}
        </span>
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
          {formatRelativeTime(commit.authorDate)}
        </span>
      </Link>
    </li>
  );
}
