"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { GitDiffPanel } from "@/components/git-diff-panel";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BASE_PATH } from "@/lib/config";
import { formatRelativeTime } from "@/lib/format";
import type { GitGraph, GitRepo, GraphRow } from "@/lib/git-graph";

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

type GitResponse = { repos: GitRepo[]; app: string; graph: GitGraph };

async function fetchPatch(projectSlug: string, app: string, hash: string): Promise<string> {
  const url = `${BASE_PATH}/api/git/diff?project=${encodeURIComponent(
    projectSlug,
  )}&app=${encodeURIComponent(app)}&hash=${hash}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { patch: string };
  return json.patch;
}

async function fetchGraph(projectSlug: string, app: string): Promise<GitResponse> {
  const url = `${BASE_PATH}/api/git?project=${encodeURIComponent(
    projectSlug,
  )}&app=${encodeURIComponent(app)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as GitResponse;
}

export function GitGraphView({
  projectSlug,
  initialApp,
  initialCommit,
}: {
  projectSlug: string;
  initialApp?: string;
  /** Hash (or prefix) to select once the graph loads. */
  initialCommit?: string;
}) {
  const [app, setApp] = useState(initialApp ?? "");
  const [data, setData] = useState<GitResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  // Selected once, on the first load that contains it.
  const pendingCommit = useRef(initialCommit?.toLowerCase());

  const showGraph = useCallback(
    (json: GitResponse) => {
      setData(json);
      setApp(json.app);
      setSelected(null);
      setPatch(null);
      setLoading(false);
      const want = pendingCommit.current;
      const row = want
        ? json.graph.rows.find((r) => r.commit.hash.startsWith(want))
        : undefined;
      if (row) {
        pendingCommit.current = undefined;
        const hash = row.commit.hash;
        setSelected(hash);
        setDiffLoading(true);
        setTimeout(
          () => document.getElementById(`commit-${hash}`)?.scrollIntoView({ block: "center" }),
          0,
        );
        fetchPatch(projectSlug, json.app, hash)
          .then(setPatch, () => setPatch(null))
          .finally(() => setDiffLoading(false));
      }
    },
    [projectSlug],
  );

  const graphFailed = useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
    setData(null);
    setLoading(false);
  }, []);

  // The repo picker: reload with the spinner.
  const load = (appSlug: string) => {
    setLoading(true);
    setError(null);
    fetchGraph(projectSlug, appSlug).then(showGraph, graphFailed);
  };

  // First load: state starts out loading, so nothing is set until the fetch ends.
  useEffect(() => {
    let active = true;
    fetchGraph(projectSlug, initialApp ?? "").then(
      (json) => active && showGraph(json),
      (e) => active && graphFailed(e),
    );
    return () => {
      active = false;
    };
  }, [projectSlug, initialApp, showGraph, graphFailed]);

  const selectCommit = useCallback(
    async (hash: string) => {
      setSelected(hash);
      setPatch(null);
      setDiffLoading(true);
      try {
        setPatch(await fetchPatch(projectSlug, app, hash));
      } catch {
        setPatch(null);
      } finally {
        setDiffLoading(false);
      }
    },
    [projectSlug, app],
  );

  if (loading)
    return <p className="text-sm text-muted-foreground">Loading history…</p>;
  if (error)
    return (
      <p className="text-sm text-destructive">
        Could not load git history: {error}
      </p>
    );
  if (!data) return null;

  const { repos, graph } = data;
  const svgWidth = PAD_X * 2 + Math.max(graph.columns, 1) * COL_W;
  const svgHeight = Math.max(graph.rows.length * ROW_H, ROW_H);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {graph.branch && <Badge variant="secondary">{graph.branch}</Badge>}
        <span className="text-xs text-muted-foreground">
          {graph.rows.length} commit{graph.rows.length === 1 ? "" : "s"}
          {graph.truncated && " (latest 200)"}
        </span>
        {graph.status.length > 0 && (
          <Badge variant="destructive">
            {graph.status.length} uncommitted
          </Badge>
        )}
        <div className="ml-auto">
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(320px,460px)_1fr]">
        {/* Graph + commit list */}
        <ScrollArea className="max-h-[70vh] rounded-md border">
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
                  selected={row.commit.hash === selected}
                  onSelect={() => void selectCommit(row.commit.hash)}
                />
              ))}
            </ul>
          </div>
        </ScrollArea>

        {/* Diff panel */}
        <div className="min-w-0">
          {!selected ? (
            <p className="text-sm text-muted-foreground">
              Select a commit to view its changes.
            </p>
          ) : diffLoading ? (
            <p className="text-sm text-muted-foreground">Loading diff…</p>
          ) : patch == null ? (
            <p className="text-sm text-destructive">Could not load diff.</p>
          ) : (
            <ScrollArea className="max-h-[70vh]">
              <GitDiffPanel patch={patch} />
            </ScrollArea>
          )}
        </div>
      </div>
    </div>
  );
}

function CommitRow({
  row,
  selected,
  onSelect,
}: {
  row: GraphRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const { commit } = row;
  return (
    <li id={`commit-${commit.hash}`} style={{ height: ROW_H }}>
      <button
        type="button"
        onClick={onSelect}
        className={`flex h-full w-full items-center gap-2 px-2 text-left text-sm hover:bg-muted/60 ${
          selected ? "bg-muted" : ""
        }`}
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
      </button>
    </li>
  );
}
