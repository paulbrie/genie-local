"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, GitCommitHorizontal, Lock, Search } from "lucide-react";

import { commitHref } from "@/components/comms/comms-panels";
import type { NodeView } from "@/components/comms/comms-view";
import { MessageBody, TagBadge, type CommitLink } from "@/components/comms/message-body";
import { MessageSheet } from "@/components/comms/message-sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CommsMessage, CommsTask } from "@/lib/claude-comms-parse";
import { agentColorMap } from "@/lib/comms-colors";
import { BASE_PATH } from "@/lib/config";
import { formatRelativeTime } from "@/lib/format";
import {
  board,
  COLUMNS,
  elapsed,
  latestStatus,
  ownerOf,
  threadOf,
  type BoardFilter,
  type BoardModel,
  type ColumnId,
} from "@/lib/task-board";

const POLL_MS = 3000;
/** Time windows, as Agents City's. */
const WINDOWS = [
  { label: "1h", hours: 1 },
  { label: "8h", hours: 8 },
  { label: "1d", hours: 24 },
  { label: "3d", hours: 72 },
  { label: "7d", hours: 168 },
];
const PREFS_KEY = "admin.tasks.prefs";
const DONE_PAGE = 20;

type Prefs = { hours: number; project: string | null; owner: string | null };

/**
 * The team's tasks in columns (To do, Doing, Blocked, Done; Cancelled folded),
 * live from /api/team/tasks. Filters: project, owner, time window, search. A
 * card opens a sheet with the task's thread, commits and claims.
 */
export function TasksBoard() {
  const [prefs, setPrefs] = useState<Prefs>({ hours: 24, project: null, owner: null });
  const [search, setSearch] = useState("");
  const [model, setModel] = useState<BoardModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const version = useRef<string | null>(null);

  // Restore the filters after mount.
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
      if (s && typeof s === "object")
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPrefs({
          hours: WINDOWS.some((w) => w.hours === s.hours) ? s.hours : 24,
          project: typeof s.project === "string" ? s.project : null,
          owner: typeof s.owner === "string" ? s.owner : null,
        });
    } catch {
      /* ignore */
    }
  }, []);
  const update = (p: Partial<Prefs>) =>
    setPrefs((cur) => {
      const next = { ...cur, ...p };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });

  const load = useCallback(async () => {
    try {
      const v = version.current ? `&v=${version.current}` : "";
      const res = await fetch(`${BASE_PATH}/api/team/tasks?hours=${prefs.hours}${v}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setError(null);
      setNow(Date.now());
      if (json.unchanged) return;
      version.current = json.version;
      setModel(json as BoardModel);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [prefs.hours]);

  useEffect(() => {
    version.current = null;
    const first = setTimeout(() => void load(), 0);
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
    };
  }, [load]);

  const colors = useMemo(() => (model ? agentColorMap(model.nodes) : new Map<string, string>()), [model]);
  const projects = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of Object.values(model?.projects ?? {})) m.set(p.id, p.name);
    return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [model]);
  const owners = useMemo(() => {
    const keys = new Set((model?.tasks ?? []).map((t) => t.worker));
    return (model?.nodes ?? []).filter((n) => keys.has(n.key)).sort((a, b) => a.name.localeCompare(b.name));
  }, [model]);
  const filter: BoardFilter = { project: prefs.project, owner: prefs.owner, search };
  const cols = useMemo(() => (model ? board(model, filter) : null), [model, filter.project, filter.owner, filter.search]); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = useMemo(() => new Map((model?.messages ?? []).map((m) => [m.id, m])), [model]);
  const open = model?.tasks.find((t) => t.key === openKey) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          label="Project"
          value={prefs.project}
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(project) => update({ project })}
        />
        <FilterSelect
          label="Owner"
          value={prefs.owner}
          options={owners.map((n) => ({ value: n.key, label: n.name }))}
          onChange={(owner) => update({ owner })}
        />
        <div className="flex items-center rounded-md border p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.hours}
              type="button"
              onClick={() => update({ hours: w.hours })}
              className={`rounded px-2 py-0.5 text-xs ${prefs.hours === w.hours ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground"}`}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search id or text" className="h-8 w-56 pl-7 text-sm" aria-label="Search tasks" />
        </div>
        <span className="ml-auto text-xs text-muted-foreground">
          {error ? `Error: ${error}` : model ? `${model.tasks.length} tasks in the last ${WINDOWS.find((w) => w.hours === prefs.hours)?.label} · live` : "Loading…"}
        </span>
      </div>

      {cols && <Columns cols={cols} model={model!} colors={colors} byId={byId} now={now} onOpen={setOpenKey} />}

      <TaskSheet task={open} model={model} colors={colors} now={now} onClose={() => setOpenKey(null)} />
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: { value: string; label: string }[];
  onChange: (v: string | null) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="h-8 rounded-md border bg-background px-2 text-sm"
    >
      <option value="">{`All ${label.toLowerCase()}s`}</option>
      {value && !options.some((o) => o.value === value) && <option value={value}>{value.split("/").pop()}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

type ColumnsProps = {
  cols: Record<ColumnId, CommsTask[]>;
  model: BoardModel;
  colors: Map<string, string>;
  byId: Map<string, CommsMessage>;
  now: number;
  onOpen: (key: string) => void;
};

/** Desktop: the columns side by side, each scrolling; narrow: one tab per column. */
function Columns(props: ColumnsProps) {
  const { cols } = props;
  const [doneShown, setDoneShown] = useState(DONE_PAGE);
  const [cancelledOpen, setCancelledOpen] = useState(false);
  const main = COLUMNS.filter((c) => c.id !== "cancelled");
  const list = (id: ColumnId) => (id === "done" ? cols.done.slice(0, doneShown) : cols[id]);
  const more = cols.done.length > doneShown && (
    <Button size="sm" variant="ghost" className="w-full" onClick={() => setDoneShown((n) => n + DONE_PAGE)}>
      Show more ({cols.done.length - doneShown})
    </Button>
  );
  const cancelled = (
    <div className="rounded-md border border-dashed">
      <button
        type="button"
        onClick={() => setCancelledOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={cancelledOpen}
      >
        {cancelledOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        Cancelled <span className="tabular-nums">({cols.cancelled.length})</span>
      </button>
      {cancelledOpen && (
        <div className="space-y-2 p-2 pt-0">
          {cols.cancelled.map((t) => (
            <TaskCard key={t.key} t={t} {...props} />
          ))}
        </div>
      )}
    </div>
  );
  return (
    <>
      <div className="hidden min-h-0 flex-1 gap-3 md:grid md:grid-cols-4">
        {main.map((c) => (
          <section key={c.id} className="flex min-h-0 flex-col rounded-md border bg-muted/20">
            <h2 className="flex items-center gap-2 border-b px-3 py-2 text-sm font-medium">
              {c.title}
              <Badge variant="secondary" className="tabular-nums">
                {cols[c.id].length}
              </Badge>
            </h2>
            <div className="max-h-[calc(100vh-14rem)] min-h-24 space-y-2 overflow-y-auto p-2">
              {list(c.id).map((t) => (
                <TaskCard key={t.key} t={t} {...props} />
              ))}
              {list(c.id).length === 0 && <p className="py-4 text-center text-xs text-muted-foreground">None</p>}
              {c.id === "done" && more}
              {c.id === "done" && cancelled}
            </div>
          </section>
        ))}
      </div>
      <Tabs defaultValue="doing" className="md:hidden">
        <TabsList className="w-full">
          {main.map((c) => (
            <TabsTrigger key={c.id} value={c.id} className="text-xs">
              {c.title} <span className="tabular-nums opacity-70">{cols[c.id].length}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        {main.map((c) => (
          <TabsContent key={c.id} value={c.id} className="space-y-2">
            {list(c.id).map((t) => (
              <TaskCard key={t.key} t={t} {...props} />
            ))}
            {list(c.id).length === 0 && <p className="py-4 text-center text-xs text-muted-foreground">None</p>}
            {c.id === "done" && more}
            {c.id === "done" && cancelled}
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}

function TaskCard({ t, model, colors, byId, now, onOpen }: ColumnsProps & { t: CommsTask }) {
  const owner = ownerOf(t, model);
  const status = latestStatus(t, byId);
  const time = elapsed(t, now);
  return (
    <button
      type="button"
      onClick={() => onOpen(t.key)}
      className={`block w-full rounded-md border bg-background p-2.5 text-left shadow-xs transition-colors hover:border-foreground/30 ${t.state === "cancelled" ? "opacity-70" : ""}`}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono font-semibold">{t.id ?? "—"}</span>
        {t.guessed && <span className="text-muted-foreground">(guessed)</span>}
        {time && <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{time}</span>}
      </div>
      <p className={`mt-1 line-clamp-3 text-sm ${t.state === "cancelled" ? "line-through" : ""}`}>{t.title}</p>
      <div className="mt-1.5 flex items-center gap-1.5 text-xs">
        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: colors.get(owner.key) ?? "#94a3b8" }} />
        <span className="truncate font-medium" style={{ color: colors.get(owner.key) }}>
          {owner.name}
        </span>
        {owner.project && <span className="truncate text-muted-foreground">· {owner.project.name}</span>}
      </div>
      {t.state === "blocked" && t.lastText ? (
        <p className="mt-1 line-clamp-2 text-xs text-destructive">{t.lastText.split("\n")[0]}</p>
      ) : (
        status && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{status}</p>
      )}
    </button>
  );
}

const STATE_LABEL: Record<CommsTask["state"], string> = {
  dispatched: "To do",
  in_progress: "Doing",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

/** A task's whole thread, its commits and claims; a message opens in Comms' message sheet. */
function TaskSheet({
  task,
  model,
  colors,
  now,
  onClose,
}: {
  task: CommsTask | null;
  model: BoardModel | null;
  colors: Map<string, string>;
  now: number;
  onClose: () => void;
}) {
  const [openMsg, setOpenMsg] = useState<string | null>(null);
  const thread = useMemo(() => (task && model ? threadOf(task, model, now) : null), [task, model, now]);
  const byKey = useMemo(
    () => new Map<string, NodeView>((model?.nodes ?? []).map((n) => [n.key, { ...n, color: colors.get(n.key) ?? "#94a3b8", pinned: false }])),
    [model, colors],
  );
  const commitLinks: CommitLink[] = useMemo(
    () => (model?.commits ?? []).map((c) => ({ abbrev: c.abbrev, hash: c.hash, href: commitHref(c), subject: c.subject })),
    [model],
  );
  const name = (key: string) => {
    const n = byKey.get(key);
    return <span style={{ color: n?.color }}>{n?.name ?? key}</span>;
  };
  const owner = task && model ? ownerOf(task, model) : null;
  const selected = thread?.messages.find((m) => m.id === openMsg) ?? null;
  return (
    <>
      <Sheet open={!!task} onOpenChange={(o) => !o && onClose()}>
        <SheetContent side="right" className="w-full sm:max-w-2xl">
          {task && thread && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <span className="font-mono">{task.id ?? "—"}</span>
                  <Badge variant="outline">{STATE_LABEL[task.state]}</Badge>
                  {elapsed(task, now) && <span className="text-sm font-normal text-muted-foreground">{elapsed(task, now)}</span>}
                </SheetTitle>
                <SheetDescription className="text-foreground">{task.title}</SheetDescription>
                <p className="text-xs text-muted-foreground">
                  {name(task.manager)} → {name(task.worker)}
                  {owner?.project && ` · ${owner.project.name}`}
                </p>
              </SheetHeader>
              <div className="space-y-4 overflow-y-auto px-4 pb-6">
                {thread.commits.length > 0 && (
                  <section>
                    <h3 className="mb-1 text-xs font-medium text-muted-foreground">Commits</h3>
                    <ul className="space-y-1 text-xs">
                      {thread.commits.map((c) => {
                        const href = commitHref(c);
                        return (
                          <li key={c.hash} className="flex items-center gap-2">
                            <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
                            {href ? (
                              <a href={href} className="font-mono underline underline-offset-2">
                                {c.abbrev}
                              </a>
                            ) : (
                              <span className="font-mono">{c.abbrev}</span>
                            )}
                            {c.mentions.some((m) => m.kind === "pushed") && <Badge variant="secondary" className="h-4 px-1 text-[10px]">pushed</Badge>}
                            <span className="truncate text-muted-foreground">{c.subject ?? ""}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
                {thread.claims.length > 0 && (
                  <section>
                    <h3 className="mb-1 text-xs font-medium text-muted-foreground">Claims</h3>
                    <ul className="space-y-0.5 text-xs">
                      {thread.claims.map((c, i) => (
                        <li key={`${c.file.path}:${i}`} className="flex items-center gap-2">
                          <Lock className={`size-3 shrink-0 ${c.action === "claim" ? "" : "opacity-40"}`} />
                          <span className="truncate font-mono">{c.file.path}</span>
                          <span className="ml-auto shrink-0 text-muted-foreground">
                            {c.action === "release" ? "released " : ""}
                            {c.at ? formatRelativeTime(c.at) : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <section>
                  <h3 className="mb-1 text-xs font-medium text-muted-foreground">Thread ({thread.messages.length})</h3>
                  <ol className="space-y-2">
                    {thread.messages.map((m) => (
                      <li key={m.id} className="rounded-md border p-2">
                        <button type="button" onClick={() => setOpenMsg(m.id)} className="flex w-full flex-wrap items-center gap-1.5 text-left text-xs hover:underline">
                          {name(m.from)} <span className="text-muted-foreground">→</span> {name(m.to)}
                          {m.tags.map((x, i) => (
                            <TagBadge key={i} tag={x.tag} />
                          ))}
                          <span className="ml-auto text-muted-foreground">{m.sentAt ? formatRelativeTime(m.sentAt) : ""}</span>
                        </button>
                        <div className="mt-1 max-h-64 overflow-y-auto text-sm">
                          <MessageBody body={m.body} commits={commitLinks} />
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
      <MessageSheet message={selected} byKey={byKey} commits={commitLinks} onClose={() => setOpenMsg(null)} />
    </>
  );
}
