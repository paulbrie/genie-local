"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  ListTree,
  Scissors,
  Skull,
  Table2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BASE_PATH } from "@/lib/config";
import type { ProcessInfo, ProcessSnapshot } from "@/lib/stats";

const POLL_MS = 5000;

type SortKey = "cpu" | "mem" | "pid" | "name" | "port";
type ViewMode = "table" | "tree";
type KillSignal = "SIGTERM" | "SIGKILL";

type KillResponse = {
  requested: number;
  outcomes: { pid: number; ok: boolean; error?: string }[];
};

export function ProcessesTable() {
  const [data, setData] = useState<ProcessSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [portsOnly, setPortsOnly] = useState(false);
  const [view, setView] = useState<ViewMode>("table");
  const [sortKey, setSortKey] = useState<SortKey>("cpu");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_PATH}/api/processes`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(String(res.status));
      const json: ProcessSnapshot = await res.json();
      setData(json);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const tick = () => {
      if (active) void load();
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [load]);

  const kill = useCallback(
    async (p: ProcessInfo, signal: KillSignal, tree: boolean) => {
      const label = tree ? `tree of ${p.name} (${p.pid})` : `${p.name} (${p.pid})`;
      try {
        const res = await fetch(`${BASE_PATH}/api/processes/kill`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pid: p.pid, signal, tree }),
        });
        const body: KillResponse = await res.json().catch(() => ({
          requested: p.pid,
          outcomes: [],
        }));
        const ok = body.outcomes.filter((o) => o.ok).length;
        const failed = body.outcomes.filter((o) => !o.ok);
        if (res.ok && failed.length === 0) {
          toast.success(
            `Sent ${signal} to ${label}${ok > 1 ? ` — ${ok} processes` : ""}`,
          );
        } else if (ok > 0) {
          toast.warning(
            `${signal} → ${ok} ok, ${failed.length} failed: ${failed[0]?.error ?? ""}`,
          );
        } else {
          toast.error(
            `Could not ${signal} ${label}: ${failed[0]?.error ?? `HTTP ${res.status}`}`,
          );
        }
      } catch (e) {
        toast.error(`Kill failed: ${(e as Error).message}`);
      } finally {
        // Reflect the change quickly rather than waiting for the next poll.
        setTimeout(() => void load(), 400);
      }
    },
    [load],
  );

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    let list = data.processes;
    if (portsOnly) list = list.filter((p) => p.port !== "");
    if (q) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.user.toLowerCase().includes(q) ||
          String(p.pid).includes(q) ||
          p.port.includes(q),
      );
    }
    return list;
  }, [data, query, portsOnly]);

  const rows = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => cmp(a, b, sortKey) * dir);
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" || key === "port" ? "asc" : "desc");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name, user, pid, port…"
          className="max-w-xs"
        />
        <Button
          size="sm"
          variant={portsOnly ? "default" : "outline"}
          onClick={() => setPortsOnly((v) => !v)}
        >
          Listening only
        </Button>
        <div className="inline-flex overflow-hidden rounded-md border">
          <Button
            size="sm"
            variant={view === "table" ? "default" : "ghost"}
            className="rounded-none"
            onClick={() => setView("table")}
          >
            <Table2 /> Table
          </Button>
          <Button
            size="sm"
            variant={view === "tree" ? "default" : "ghost"}
            className="rounded-none"
            onClick={() => setView("tree")}
          >
            <ListTree /> Tree
          </Button>
        </div>
        <span className="ml-auto text-sm text-muted-foreground">
          {error
            ? "stats unavailable"
            : data
              ? `${filtered.length} shown · updated ${new Date(
                  data.ts,
                ).toLocaleTimeString()}`
              : "loading…"}
        </span>
      </div>

      {data && data.openPorts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-muted-foreground">Listening ports:</span>
          {data.openPorts.map((p) => (
            <Badge
              key={p}
              variant={data.externalPorts.includes(p) ? "default" : "secondary"}
              title={
                data.externalPorts.includes(p)
                  ? "externally reachable"
                  : "local only"
              }
            >
              {p}
            </Badge>
          ))}
          <span className="text-xs text-muted-foreground">
            (filled = external)
          </span>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Right-click (or long-press on touch) a process for actions (kill, force
        kill, kill tree, copy PID).
      </p>

      {view === "table" ? (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead label="PID" k="pid" {...{ sortKey, sortDir, toggleSort }} />
                <SortableHead label="Name" k="name" {...{ sortKey, sortDir, toggleSort }} />
                <TableHead>User</TableHead>
                <SortableHead label="Port" k="port" {...{ sortKey, sortDir, toggleSort }} />
                <SortableHead
                  label="CPU %"
                  k="cpu"
                  align="right"
                  {...{ sortKey, sortDir, toggleSort }}
                />
                <SortableHead
                  label="Mem (MB)"
                  k="mem"
                  align="right"
                  {...{ sortKey, sortDir, toggleSort }}
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    {data ? "No matching processes." : "…"}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((p) => <Row key={p.pid} p={p} onKill={kill} />)
              )}
            </TableBody>
          </Table>
        </div>
      ) : (
        <ProcessTree procs={filtered} onKill={kill} loading={!data} />
      )}
    </div>
  );
}

/* ------------------------------ table view ------------------------------ */

function Row({
  p,
  onKill,
}: {
  p: ProcessInfo;
  onKill: KillFn;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<TableRow />}>
        <TableCell className="font-mono text-xs">{p.pid}</TableCell>
        <TableCell className="max-w-[24rem] truncate font-medium">
          {p.name}
        </TableCell>
        <TableCell className="text-muted-foreground">{p.user}</TableCell>
        <TableCell>
          {p.port ? <Badge variant="secondary">{p.port}</Badge> : "—"}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {p.cpu.toFixed(1)}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {Math.round(p.mem)}
        </TableCell>
      </ContextMenuTrigger>
      <ProcessMenu p={p} onKill={onKill} />
    </ContextMenu>
  );
}

/* ------------------------------- tree view ------------------------------ */

type TreeNode = ProcessInfo & { children: TreeNode[]; depth: number };

/**
 * Build a spawn forest from the flat process list using ppid. A process whose
 * parent isn't in the (possibly filtered) set becomes a root, so the forest
 * stays connected even when the daemon omits system ancestors.
 */
function buildForest(procs: ProcessInfo[]): TreeNode[] {
  const byPid = new Map<number, TreeNode>();
  for (const p of procs) byPid.set(p.pid, { ...p, children: [], depth: 0 });

  const roots: TreeNode[] = [];
  for (const node of byPid.values()) {
    const parent = byPid.get(node.ppid);
    if (parent && parent.pid !== node.pid) parent.children.push(node);
    else roots.push(node);
  }

  const sortRec = (nodes: TreeNode[], depth: number) => {
    nodes.sort((a, b) => b.cpu - a.cpu || a.pid - b.pid);
    for (const n of nodes) {
      n.depth = depth;
      sortRec(n.children, depth + 1);
    }
  };
  sortRec(roots, 0);
  return roots;
}

function ProcessTree({
  procs,
  onKill,
  loading,
}: {
  procs: ProcessInfo[];
  onKill: KillFn;
  loading: boolean;
}) {
  const forest = useMemo(() => buildForest(procs), [procs]);

  if (loading) {
    return <div className="rounded-md border p-6 text-sm text-muted-foreground">…</div>;
  }
  if (forest.length === 0) {
    return (
      <div className="rounded-md border p-6 text-center text-sm text-muted-foreground">
        No matching processes.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <div className="min-w-[36rem] p-1 font-mono text-xs">
        {forest.map((n) => (
          <TreeRow key={n.pid} node={n} onKill={onKill} />
        ))}
      </div>
    </div>
  );
}

function TreeRow({ node, onKill }: { node: TreeNode; onKill: KillFn }) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger
          className="flex items-center gap-2 rounded py-1 pr-1.5 hover:bg-muted/60"
          style={{ paddingLeft: `${node.depth * 18 + 6}px` }}
        >
          <button
            type="button"
            onClick={() => hasChildren && setOpen((v) => !v)}
            className={
              hasChildren
                ? "shrink-0 text-muted-foreground hover:text-foreground"
                : "pointer-events-none shrink-0 opacity-0"
            }
            aria-label={open ? "Collapse" : "Expand"}
          >
            {open ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
          <span className="w-14 shrink-0 text-muted-foreground tabular-nums">
            {node.pid}
          </span>
          <span className="min-w-0 flex-1 truncate font-sans font-medium">
            {node.name}
          </span>
          {node.port && (
            <Badge variant="secondary" className="shrink-0">
              {node.port}
            </Badge>
          )}
          {hasChildren && (
            <span className="shrink-0 text-muted-foreground">
              {node.children.length}▸
            </span>
          )}
          <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
            {node.cpu.toFixed(1)}%
          </span>
          <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
            {Math.round(node.mem)}MB
          </span>
        </ContextMenuTrigger>
        <ProcessMenu p={node} onKill={onKill} hasChildren={hasChildren} />
      </ContextMenu>
      {hasChildren &&
        open &&
        node.children.map((c) => (
          <TreeRow key={c.pid} node={c} onKill={onKill} />
        ))}
    </div>
  );
}

/* ---------------------------- shared context menu ---------------------------- */

type KillFn = (p: ProcessInfo, signal: KillSignal, tree: boolean) => void;

function ProcessMenu({
  p,
  onKill,
  hasChildren,
}: {
  p: ProcessInfo;
  onKill: KillFn;
  hasChildren?: boolean;
}) {
  return (
    <ContextMenuContent>
      <ContextMenuLabel className="truncate">
        {p.name} · {p.pid}
      </ContextMenuLabel>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onKill(p, "SIGTERM", false)}>
        <X /> Kill (SIGTERM)
      </ContextMenuItem>
      <ContextMenuItem
        variant="destructive"
        onClick={() => onKill(p, "SIGKILL", false)}
      >
        <Skull /> Force kill (SIGKILL)
      </ContextMenuItem>
      <ContextMenuItem
        variant="destructive"
        disabled={hasChildren === false}
        onClick={() => onKill(p, "SIGKILL", true)}
      >
        <Scissors /> Force kill tree
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={() => {
          void navigator.clipboard?.writeText(String(p.pid));
          toast.success(`Copied PID ${p.pid}`);
        }}
      >
        <Copy /> Copy PID
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

/* -------------------------------- helpers -------------------------------- */

function SortableHead({
  label,
  k,
  align,
  sortKey,
  sortDir,
  toggleSort,
}: {
  label: string;
  k: SortKey;
  align?: "right";
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  toggleSort: (k: SortKey) => void;
}) {
  const active = sortKey === k;
  return (
    <TableHead className={align === "right" ? "text-right" : undefined}>
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {label}
        {active && <span>{sortDir === "asc" ? "▲" : "▼"}</span>}
      </button>
    </TableHead>
  );
}

function cmp(a: ProcessInfo, b: ProcessInfo, key: SortKey): number {
  switch (key) {
    case "cpu":
      return a.cpu - b.cpu;
    case "mem":
      return a.mem - b.mem;
    case "pid":
      return a.pid - b.pid;
    case "port":
      return (Number(a.port) || 0) - (Number(b.port) || 0);
    case "name":
      return a.name.localeCompare(b.name);
  }
}
