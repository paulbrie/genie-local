"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSubject } from "subjecto/react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CommsModel, CommsNode, CommsRole } from "@/lib/claude-comms-parse";
import { agentColorMap } from "@/lib/comms-colors";
import { BASE_PATH } from "@/lib/config";
import { formatRelativeTime } from "@/lib/format";
import { commsPrefs, hydrateCommsPrefs, setCommsPrefs } from "@/store/comms";

import { commitHref, CommitsPanel, FilesPanel, TasksPanel } from "./comms-panels";
import { MessageSheet } from "./message-sheet";
import { SequenceDiagram } from "./sequence-diagram";

const POLL_MS = 3000;
const DAY_OPTIONS = [1, 3, 7, 30];

export type NodeView = CommsNode & { color: string; pinned: boolean };

export function CommsView() {
  const [days, setDays] = useState(7);
  const [model, setModel] = useState<CommsModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [cwd, setCwd] = useState<string>("");
  const [prefs] = useSubject(commsPrefs);
  const { pins, hidden } = prefs;
  const [openMsg, setOpenMsg] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<Set<string> | null>(null);
  const version = useRef<string | null>(null);

  useEffect(() => {
    hydrateCommsPrefs();
  }, []);

  const load = useCallback(async () => {
    try {
      const v = version.current ? `&v=${version.current}` : "";
      const res = await fetch(`${BASE_PATH}/api/claude/comms?days=${days}${v}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setError(null);
      if (json.unchanged) return;
      version.current = json.version;
      setModel(json as CommsModel);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [days]);

  // Load now (fresh, since `days` may have changed), then poll while live.
  useEffect(() => {
    version.current = null;
    const first = setTimeout(() => void load(), 0);
    const poll = live
      ? setInterval(() => {
          if (document.visibilityState === "visible") void load();
        }, POLL_MS)
      : undefined;
    return () => {
      clearTimeout(first);
      clearInterval(poll);
    };
  }, [live, load]);

  const nodes: NodeView[] = useMemo(() => {
    if (!model) return [];
    // Fixed colours for named agents, the rest keyed by session (stable under filters).
    const color = agentColorMap(model.nodes);
    const rank: Record<CommsRole, number> = { manager: 0, peer: 1, worker: 2 };
    return model.nodes
      .map((n) => ({
        ...n,
        role: pins[n.key] ?? n.role,
        pinned: !!pins[n.key],
        color: color.get(n.key)!,
      }))
      .sort(
        (a, b) =>
          rank[a.role] - rank[b.role] ||
          b.sent + b.received - (a.sent + a.received) ||
          a.name.localeCompare(b.name),
      );
  }, [model, pins]);

  const cwds = useMemo(
    () => [...new Set(nodes.map((n) => n.cwd).filter((c): c is string => !!c))].sort(),
    [nodes],
  );

  const visible = useMemo(
    () => nodes.filter((n) => !hidden.includes(n.key) && (!cwd || n.cwd === cwd)),
    [nodes, hidden, cwd],
  );
  const visibleKeys = useMemo(() => new Set(visible.map((n) => n.key)), [visible]);
  const byKey = useMemo(() => new Map(nodes.map((n) => [n.key, n])), [nodes]);

  const messages = useMemo(
    () =>
      (model?.messages ?? []).filter((m) => visibleKeys.has(m.from) && visibleKeys.has(m.to)),
    [model, visibleKeys],
  );
  const tasks = useMemo(
    () =>
      (model?.tasks ?? []).filter((t) => visibleKeys.has(t.manager) || visibleKeys.has(t.worker)),
    [model, visibleKeys],
  );
  const files = useMemo(
    () => (model?.files ?? []).filter((f) => f.history.some((h) => visibleKeys.has(h.node))),
    [model, visibleKeys],
  );
  const commits = useMemo(
    () => (model?.commits ?? []).filter((c) => c.mentions.some((m) => visibleKeys.has(m.node))),
    [model, visibleKeys],
  );

  function toggleHidden(key: string) {
    const next = hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key];
    setCommsPrefs({ ...prefs, hidden: next });
  }

  function cycleRole(n: NodeView) {
    // auto → manager → worker → peer → auto
    const order: (CommsRole | undefined)[] = [undefined, "manager", "worker", "peer"];
    const next = order[(order.indexOf(pins[n.key]) + 1) % order.length];
    const p = { ...pins };
    if (next) p[n.key] = next;
    else delete p[n.key];
    setCommsPrefs({ ...prefs, pins: p });
  }

  const commitLinks = useMemo(
    () =>
      (model?.commits ?? []).map((c) => ({
        abbrev: c.abbrev,
        hash: c.hash,
        href: commitHref(c),
        subject: c.subject,
      })),
    [model],
  );

  const selected = openMsg ? model?.messages.find((m) => m.id === openMsg) ?? null : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`px-2.5 py-1 text-xs ${d === days ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60"}`}
            >
              {d}d
            </button>
          ))}
        </div>
        {cwds.length > 1 && (
          <select
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            className="h-7 rounded-md border bg-background px-2 font-mono text-xs"
            aria-label="Working directory"
          >
            <option value="">all directories</option>
            {cwds.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        <Button size="sm" variant={live ? "secondary" : "outline"} onClick={() => setLive(!live)}>
          <StatusDot color={live ? "bg-emerald-500" : "bg-muted-foreground"} pulse={live} />
          {live ? "Live" : "Paused"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          Refresh
        </Button>
        {highlight && (
          <Button size="sm" variant="ghost" onClick={() => setHighlight(null)}>
            Clear highlight
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {error ? (
            <span className="text-destructive">Error: {error}</span>
          ) : model ? (
            <>
              {messages.length} of {model.messages.length} messages · updated{" "}
              {formatRelativeTime(model.generatedAt)}
            </>
          ) : (
            "Loading…"
          )}
        </span>
      </div>

      {/* Sessions */}
      {nodes.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {nodes.map((n) => (
            <SessionChip
              key={n.key}
              n={n}
              hidden={hidden.includes(n.key) || (!!cwd && n.cwd !== cwd)}
              onToggle={() => toggleHidden(n.key)}
              onRole={() => cycleRole(n)}
            />
          ))}
        </div>
      )}

      {model && model.messages.length === 0 ? (
        <div className="grid flex-1 place-items-center rounded-md border p-10 text-sm text-muted-foreground">
          No messages between sessions in the last {days} day{days === 1 ? "" : "s"}.
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_26rem]">
          <SequenceDiagram
            nodes={visible}
            byKey={byKey}
            messages={messages}
            highlight={highlight}
            onOpen={setOpenMsg}
          />
          <Tabs defaultValue="tasks" className="min-w-0">
            <TabsList>
              <TabsTrigger value="tasks">Tasks ({tasks.length})</TabsTrigger>
              <TabsTrigger value="files">Files ({files.length})</TabsTrigger>
              <TabsTrigger value="commits">Commits ({commits.length})</TabsTrigger>
            </TabsList>
            <TabsContent value="tasks" className="pt-2">
              <TasksPanel
                tasks={tasks}
                byKey={byKey}
                onHighlight={(ids) => setHighlight(new Set(ids))}
                onOpen={setOpenMsg}
              />
            </TabsContent>
            <TabsContent value="files" className="pt-2">
              <FilesPanel files={files} byKey={byKey} onOpen={setOpenMsg} />
            </TabsContent>
            <TabsContent value="commits" className="pt-2">
              <CommitsPanel commits={commits} byKey={byKey} onOpen={setOpenMsg} />
            </TabsContent>
          </Tabs>
        </div>
      )}

      <MessageSheet
        message={selected}
        byKey={byKey}
        commits={commitLinks}
        onClose={() => setOpenMsg(null)}
      />
    </div>
  );
}

const ROLE_VARIANT: Record<CommsRole, "default" | "secondary" | "outline"> = {
  manager: "default",
  worker: "secondary",
  peer: "outline",
};

function SessionChip({
  n,
  hidden,
  onToggle,
  onRole,
}: {
  n: NodeView;
  hidden: boolean;
  onToggle: () => void;
  onRole: () => void;
}) {
  const formerly = n.names
    .map((x) => x.name)
    .filter((x) => x !== n.name);
  const title = [
    n.sessionId ? `session ${n.sessionId}` : "session not found in transcripts",
    n.cwd,
    n.gitBranch && `branch ${n.gitBranch}`,
    n.tmux && `tmux ${n.tmux}`,
    n.sockets.length > 0 && n.sockets.join(", "),
    formerly.length > 0 && `formerly ${[...new Set(formerly)].join(", ")}`,
    `${n.sent} sent · ${n.received} received`,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div
      className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${hidden ? "opacity-40" : ""}`}
      title={title}
    >
      <span className="size-2.5 shrink-0 rounded-full" style={{ background: n.color }} />
      <button type="button" onClick={onToggle} className="font-medium hover:underline">
        {n.name}
      </button>
      <span className="font-mono text-[10px] text-muted-foreground">{n.shortId}</span>
      {n.live ? (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <StatusDot
            size="sm"
            color={n.status === "busy" ? "bg-amber-500" : "bg-emerald-500"}
            pulse={n.status === "busy"}
          />
          {n.status ?? "live"}
        </span>
      ) : (
        <span className="text-[10px] text-muted-foreground">ended</span>
      )}
      <button type="button" onClick={onRole} title="Click to pin the role (auto → manager → worker → peer)">
        <Badge variant={ROLE_VARIANT[n.role]} className="h-4 px-1.5 text-[10px]">
          {n.role}
          {n.pinned ? " 📌" : ""}
        </Badge>
      </button>
    </div>
  );
}
