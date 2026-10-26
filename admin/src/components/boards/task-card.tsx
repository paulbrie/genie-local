"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CircleCheck, CircleDashed, CircleDot, ListTodo, Loader2, Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { BASE_PATH } from "@/lib/config";
import type { TaskObj } from "@/lib/boards/core.mjs";
import { cn } from "@/lib/utils";

/** A project's ticket as the board sees it (GET /api/projects/<slug>/tasks). */
export type TicketLine = { id: number; title: string; status: TaskObj["status"]; assignee: string | null };
type Project = { slug: string; openTasks: number; inProgress: number };

export const taskHref = (project: string, taskId: number) =>
  `${BASE_PATH}/projects/${encodeURIComponent(project)}/tasks?task=${taskId}`;

// ------------------------------------------------------------ live tickets

/**
 * Every Task card of a project shares one list of its tickets, fetched when a
 * card first needs it and again while any card is on screen, so a ticket moved
 * on the Tasks page (or by its Claude) shows here within half a minute.
 */
type Entry = { tickets: TicketLine[] | null; missing?: true; at: number; loading?: Promise<void> };
const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
const users = new Map<string, number>();
const STALE_MS = 30_000;

function load(slug: string, force = false) {
  const e = cache.get(slug);
  if (e?.loading || (!force && e && Date.now() - e.at < STALE_MS)) return e?.loading;
  const loading = fetch(`${BASE_PATH}/api/projects/${encodeURIComponent(slug)}/tasks`, { cache: "no-store" })
    .then(async (res) => {
      if (res.status === 404) {
        cache.set(slug, { tickets: [], missing: true, at: Date.now() });
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      cache.set(slug, { tickets: ((await res.json()).tasks ?? []) as TicketLine[], at: Date.now() });
    })
    .catch(() => {
      cache.set(slug, { tickets: cache.get(slug)?.tickets ?? null, at: Date.now() });
    })
    .finally(() => listeners.forEach((l) => l()));
  cache.set(slug, { ...(e ?? { tickets: null, at: 0 }), loading });
  return loading;
}

/** Fetch a project's tickets now (after one is created or edited here). */
export const refreshTickets = (slug: string) => load(slug, true);

let timer: ReturnType<typeof setInterval> | null = null;
function watch(slug: string) {
  users.set(slug, (users.get(slug) ?? 0) + 1);
  load(slug);
  if (!timer) {
    timer = setInterval(() => {
      if (document.visibilityState === "visible") for (const s of users.keys()) load(s);
    }, STALE_MS);
  }
  return () => {
    const n = (users.get(slug) ?? 1) - 1;
    if (n > 0) users.set(slug, n);
    else users.delete(slug);
    if (!users.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function useTickets(slug: string | null) {
  useEffect(() => (slug ? watch(slug) : undefined), [slug]);
  return useSyncExternalStore(
    subscribe,
    () => (slug ? cache.get(slug) : undefined),
    () => undefined,
  );
}

// ------------------------------------------------------------ the card

const STATUS: Record<TaskObj["status"], { label: string; icon: typeof CircleDot; className: string }> = {
  open: { label: "Open", icon: CircleDashed, className: "bg-zinc-100 text-zinc-700" },
  in_progress: { label: "In progress", icon: CircleDot, className: "bg-amber-100 text-amber-800" },
  done: { label: "Done", icon: CircleCheck, className: "bg-emerald-100 text-emerald-800" },
};

/**
 * A Task element: a Link card to one ticket of a project on this server, with
 * the ticket's title, status and assignee as they are now (the object keeps
 * them as last seen, for when the project can't be reached).
 */
export function TaskCard({ o, selected }: { o: TaskObj; selected?: boolean }) {
  const entry = useTickets(o.project);
  const live = entry?.tickets?.find((t) => t.id === o.taskId);
  const gone = !!entry?.tickets && !live && !entry.loading;
  const status = STATUS[live?.status ?? o.status] ?? STATUS.open;
  const Icon = status.icon;
  const title = live?.title ?? o.title;
  return (
    <a
      href={taskHref(o.project, o.taskId)}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "flex h-full w-full flex-col gap-1 overflow-hidden rounded-lg border border-l-4 bg-card p-3 no-underline shadow-sm",
        (live?.status ?? o.status) === "done" ? "border-l-emerald-500" : (live?.status ?? o.status) === "in_progress" ? "border-l-amber-500" : "border-l-zinc-400",
        selected ? "pointer-events-auto hover:bg-muted/50" : "pointer-events-none",
      )}
      title={`${o.project} #${o.taskId}: open the ticket`}
    >
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <ListTodo className="size-3 shrink-0" />
        <span className="truncate">
          {o.project} <span className="opacity-70">#{o.taskId}</span>
        </span>
        <span className={cn("ml-auto flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium", status.className)}>
          <Icon className="size-3" />
          {status.label}
        </span>
      </span>
      <span className={cn("line-clamp-2 text-sm font-semibold leading-snug text-foreground", (live?.status ?? o.status) === "done" && "line-through decoration-foreground/30")}>
        {title || `Ticket #${o.taskId}`}
      </span>
      {gone ? (
        <span className="text-xs text-destructive">{entry?.missing ? "No such project on this server" : "This ticket was deleted"}</span>
      ) : live?.assignee ? (
        <span className="truncate text-xs text-muted-foreground">With {live.assignee}</span>
      ) : (
        o.desc && <span className="line-clamp-2 text-xs text-muted-foreground">{o.desc}</span>
      )}
    </a>
  );
}

// ------------------------------------------------------------ the picker

/** What a picked ticket puts on the board. */
export type PickedTask = Pick<TaskObj, "project" | "taskId" | "title" | "status" | "desc">;

/**
 * Pick the ticket a Task card links to: a project, then one of its tickets
 * (searched by title or number), or a new ticket filed there and then.
 */
export function TaskPicker({
  open,
  initial,
  onPick,
  onClose,
}: {
  open: boolean;
  initial?: { project: string; taskId?: number } | null;
  onPick: (t: PickedTask) => void;
  onClose: () => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [project, setProject] = useState<string | null>(initial?.project ?? null);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entry = useTickets(open ? project : null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch(`${BASE_PATH}/api/projects`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => live && setProjects(d.projects ?? []))
      .catch(() => live && setProjects([]));
    return () => {
      live = false;
    };
  }, [open]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^#/, "");
    const list = entry?.tickets ?? [];
    const order = { in_progress: 0, open: 1, done: 2 } as const;
    return list
      .filter((t) => !needle || t.title.toLowerCase().includes(needle) || String(t.id) === needle)
      .sort((a, b) => order[a.status] - order[b.status])
      .slice(0, 200);
  }, [entry, q]);

  const create = async () => {
    if (!project || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("title", title.trim());
      if (desc.trim()) fd.set("description", desc.trim());
      const res = await fetch(`${BASE_PATH}/api/projects/${encodeURIComponent(project)}/tasks`, { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `couldn't create the ticket (${res.status})`);
      void refreshTickets(project);
      onPick({ project, taskId: body.id, title: title.trim(), status: "open", desc: desc.trim().slice(0, 400) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "couldn't create the ticket");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl" onKeyDown={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Task</DialogTitle>
          <DialogDescription>Link a ticket from one of this server&apos;s projects, or file a new one there.</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto" data-testid="task-projects">
          {projects === null && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          {projects?.map((p) => (
            <button
              key={p.slug}
              type="button"
              onClick={() => {
                setProject(p.slug);
                setQ("");
              }}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs",
                p.slug === project ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
              )}
            >
              {p.slug}
              {p.openTasks > 0 && <span className="ml-1 opacity-60">{p.openTasks}</span>}
            </button>
          ))}
        </div>
        {project && !creating && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${project}'s tickets, or #number`} className="pl-7" />
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  setCreating(true);
                  setTitle(q.trim().replace(/^#\d*$/, ""));
                }}
                data-testid="task-new"
              >
                <Plus /> New ticket
              </Button>
            </div>
            <div className="max-h-72 divide-y overflow-y-auto rounded-md border">
              {!entry?.tickets && <div className="p-3 text-sm text-muted-foreground">Loading…</div>}
              {entry?.tickets && !shown.length && <div className="p-3 text-sm text-muted-foreground">No tickets{q ? " match" : " yet"}.</div>}
              {shown.map((t) => {
                const s = STATUS[t.status] ?? STATUS.open;
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted", t.id === initial?.taskId && project === initial?.project && "bg-muted")}
                    onClick={() => onPick({ project, taskId: t.id, title: t.title.slice(0, 200), status: t.status, desc: "" })}
                  >
                    <span className="w-10 shrink-0 text-xs text-muted-foreground">#{t.id}</span>
                    <span className={cn("min-w-0 flex-1 truncate", t.status === "done" && "text-muted-foreground line-through")}>{t.title}</span>
                    <span className={cn("shrink-0 rounded-full px-1.5 text-[10px]", s.className)}>{s.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {project && creating && (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`New ticket in ${project}`} maxLength={500} />
            <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description (optional)" rows={4} maxLength={5000} />
            {error && <div className="text-sm text-destructive">{error}</div>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                Back
              </Button>
              <Button type="submit" disabled={busy || !title.trim()} data-testid="task-create">
                {busy && <Loader2 className="animate-spin" />} Create and place
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
