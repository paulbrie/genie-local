"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSubject } from "subjecto/react";

import { commitHref } from "@/components/comms/comms-panels";
import type { NodeView } from "@/components/comms/comms-view";
import { MessageSheet } from "@/components/comms/message-sheet";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import {
  busiest,
  buildTimeline,
  filterTimeline,
  listProjects,
  type ProjectInfo,
  snapshotAt,
  TASK_COLORS,
  TOOL_COLORS,
  toolKind,
  type Snapshot,
  type Timeline,
} from "@/lib/agents3d-timeline";
import { layoutCities } from "@/lib/city-layout";
import { TAG_COLORS } from "@/lib/comms-colors";
import { formatRelativeTime } from "@/lib/format";
import { commsPrefs, hydrateCommsPrefs, setCommsPrefs } from "@/store/comms";

import { Clock } from "./clock";
import type { Selection } from "./scene";
import { useAgents3D } from "./use-agents3d";

const Scene = dynamic(() => import("./scene"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-white/60">Loading 3D…</div>,
});

const DAYS = [1, 3, 7];
const SPEEDS = [1, 10, 60, 300, 1200];

function subscribeReduced(f: () => void) {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", f);
  return () => mq.removeEventListener("change", f);
}
const getReduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const hhmm = (ms: number) =>
  new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function Agents3DView() {
  const [days, setDays] = useState(1);
  const [follow, setFollow] = useState("");
  const [bloomPref, setBloom] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [openMsg, setOpenMsg] = useState<string | null>(null);
  const [prefs] = useSubject(commsPrefs);
  const reduced = useSyncExternalStore(subscribeReduced, getReduced, () => false);
  const bloom = bloomPref ?? !reduced;

  const [clock] = useState(() => new Clock());
  useEffect(() => clock.start(), [clock]);
  useEffect(() => hydrateCommsPrefs(), []);
  const tick = useSyncExternalStore(clock.subscribe, clock.getTick, () => 0);

  const { model, error } = useAgents3D(days, true);
  const fullTl = useMemo(() => (model ? buildTimeline(model, prefs.pins) : null), [model, prefs.pins]);
  const projects = useMemo(() => (fullTl ? listProjects(fullTl) : []), [fullTl]);

  // Project filter: hidden ids persist (new projects show by default); ?projects=a,b lists the shown ones.
  const [urlProjects] = useState(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("projects"),
  );
  const urlApplied = useRef(urlProjects === null);
  useEffect(() => {
    if (urlApplied.current || projects.length === 0) return;
    const shown = new Set((urlProjects ?? "").split(",").filter(Boolean));
    setCommsPrefs({
      ...commsPrefs.getValue(),
      hiddenProjects: projects.filter((p) => !shown.has(p.name) && !shown.has(p.id)).map((p) => p.id),
    });
    urlApplied.current = true;
  }, [projects, urlProjects]);
  const hidden = useMemo(() => new Set(prefs.hiddenProjects), [prefs.hiddenProjects]);
  useEffect(() => {
    if (!urlApplied.current || projects.length === 0) return;
    const url = new URL(window.location.href);
    const anyHidden = projects.some((p) => hidden.has(p.id));
    if (anyHidden)
      url.searchParams.set(
        "projects",
        projects
          .filter((p) => !hidden.has(p.id))
          .map((p) => p.name)
          .join(","),
      );
    else url.searchParams.delete("projects");
    window.history.replaceState(window.history.state, "", url);
  }, [hidden, projects]);

  const tl = useMemo(() => (fullTl ? filterTimeline(fullTl, hidden) : null), [fullTl, hidden]);
  useEffect(() => {
    if (fullTl) clock.setEnd(fullTl.end);
  }, [fullTl, clock]);
  const layout = useMemo(() => layoutCities(tl?.repos ?? []), [tl?.repos]);
  // Re-frame the camera when the selection of projects changes.
  const frameKey = useMemo(() => [...hidden].filter((h) => projects.some((p) => p.id === h)).sort().join("|"), [hidden, projects]);
  // Recomputed ~4×/s as the clock moves; `tick` is the dependency that drives it.
  const snap = useMemo(
    () => (tl ? snapshotAt(tl, clock.now(), clock.live) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tl, tick, clock],
  );

  const followKey = useMemo(() => {
    if (!snap || !tl) return null;
    const key =
      follow === "busiest"
        ? busiest(snap)
        : follow.startsWith("task:")
          ? (snap.tasks.find((t) => t.key === follow.slice(5))?.worker ?? null)
          : follow || null;
    // Hidden agents can't be followed.
    return key && tl.byKey.has(key) ? key : null;
  }, [follow, snap, tl]);

  const byKey = useMemo(
    () =>
      new Map<string, NodeView>(
        (tl?.agents ?? []).map((a) => [a.key, { ...a.node, role: a.role, color: a.color, pinned: !!prefs.pins[a.key] }]),
      ),
    [tl, prefs.pins],
  );
  const commitLinks = useMemo(
    () => (model?.comms.commits ?? []).map((c) => ({ abbrev: c.abbrev, hash: c.hash, href: commitHref(c), subject: c.subject })),
    [model],
  );
  const message = openMsg ? (model?.comms.messages.find((m) => m.id === openMsg) ?? null) : null;

  const t = clock.now();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <ProjectsFilter
          projects={projects}
          hidden={hidden}
          onChange={(ids) => setCommsPrefs({ ...commsPrefs.getValue(), hiddenProjects: [...ids] })}
        />
        <Button size="sm" variant={clock.live ? "secondary" : "outline"} onClick={() => clock.goLive()}>
          <StatusDot color={clock.live ? "bg-emerald-500" : "bg-muted-foreground"} pulse={clock.live} />
          Live
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (clock.live) clock.seek(tl?.start ?? Date.now() - 3_600_000);
            clock.setPlaying(!clock.playing || clock.live);
          }}
        >
          {clock.live ? "Replay" : clock.playing ? "Pause" : "Play"}
        </Button>
        <select
          aria-label="Replay speed"
          value={clock.speed}
          onChange={(e) => clock.setSpeed(Number(e.target.value))}
          className="h-7 rounded-md border bg-background px-1.5 text-xs"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <div className="flex rounded-md border">
          {DAYS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`px-2 py-1 text-xs ${d === days ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60"}`}
            >
              {d}d
            </button>
          ))}
        </div>
        <select
          aria-label="Follow"
          value={follow}
          onChange={(e) => setFollow(e.target.value)}
          className="h-7 max-w-48 rounded-md border bg-background px-1.5 text-xs"
        >
          <option value="">Free camera</option>
          <option value="busiest">Follow the busiest agent</option>
          {tl?.agents.map((a) => (
            <option key={a.key} value={a.key}>
              Follow {a.name}
            </option>
          ))}
          {snap?.tasks
            .filter((x) => x.state !== "done" && x.id)
            .map((x) => (
              <option key={x.key} value={`task:${x.key}`}>
                Follow task {x.id}
              </option>
            ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <input type="checkbox" checked={bloom} onChange={(e) => setBloom(e.target.checked)} />
          Glow
        </label>
        <Link href="/comms" className="ml-auto text-xs text-muted-foreground underline underline-offset-2">
          2D view: Comms
        </Link>
      </div>

      {/* Scrubber */}
      <div className="flex items-center gap-3">
        <input
          type="range"
          aria-label="Time"
          className="flex-1 accent-primary"
          min={tl?.start ?? 0}
          max={tl?.end ?? 1}
          step={1000}
          value={Math.min(t, tl?.end ?? t)}
          onChange={(e) => clock.seek(Number(e.target.value))}
        />
        <span className="w-56 text-right font-mono text-xs text-muted-foreground">
          {clock.live ? "live · " : ""}
          {hhmm(t)}
        </span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="relative h-[calc(100vh-15rem)] min-h-[28rem] overflow-hidden rounded-md border bg-[#03050a]">
          {error && <p className="absolute top-2 left-2 z-10 text-xs text-destructive">Error: {error}</p>}
          {tl && snap ? (
            <Scene
              tl={tl}
              snap={snap}
              clock={clock}
              layout={layout}
              frameKey={frameKey}
              followKey={followKey}
              bloom={bloom}
              reduced={reduced}
              selected={selected}
              onSelect={setSelected}
            />
          ) : (
            <div className="grid h-full place-items-center text-sm text-white/60">Loading agents…</div>
          )}
          <Legend />
          {tl && tl.hiddenMessages > 0 && (
            <p className="pointer-events-none absolute top-2 right-2 rounded bg-black/50 px-2 py-0.5 text-[10px] text-white/70">
              {tl.hiddenMessages} message{tl.hiddenMessages === 1 ? "" : "s"} to or from hidden projects not shown
            </p>
          )}
        </div>
        <aside className="max-h-[calc(100vh-15rem)] min-h-0 overflow-auto rounded-md border p-3 text-sm">
          {tl && snap && (
            <SidePanel tl={tl} snap={snap} selected={selected} onSelect={setSelected} onOpen={setOpenMsg} />
          )}
        </aside>
      </div>

      <MessageSheet message={message} byKey={byKey} commits={commitLinks} onClose={() => setOpenMsg(null)} />
    </div>
  );
}

function Legend() {
  const tags: [string, string][] = [
    ["TASK", TAG_COLORS.TASK],
    ["ACK/STATUS", TAG_COLORS.ACK],
    ["BLOCKED", TAG_COLORS.BLOCKED],
    ["DONE", TAG_COLORS.DONE],
    ["COMMIT", TAG_COLORS.COMMIT],
    ["PUSHED", TAG_COLORS.PUSHED],
  ];
  const extra: [string, string][] = [
    ["held file (holder's colour)", "#e2e8f0"],
    ["two holders: clash", "#ef4444"],
    ["uncommitted", "#f59e0b"],
  ];
  return (
    <div className="pointer-events-none absolute bottom-2 left-2 flex max-w-[70%] flex-wrap gap-x-3 gap-y-1 rounded bg-black/50 px-2 py-1 text-[10px] text-white/75">
      {[...tags, ...extra].map(([l, c]) => (
        <span key={l} className="flex items-center gap-1">
          <span className="size-2 rounded-full" style={{ background: c }} />
          {l}
        </span>
      ))}
    </div>
  );
}

function SidePanel({
  tl,
  snap,
  selected,
  onSelect,
  onOpen,
}: {
  tl: Timeline;
  snap: Snapshot;
  selected: Selection | null;
  onSelect: (s: Selection | null) => void;
  onOpen: (id: string) => void;
}) {
  const name = (k: string) => tl.byKey.get(k)?.name ?? "?";
  const dot = (k: string) => <Dot tl={tl} k={k} />;
  const recentMsgs = (filter: (m: Timeline["messages"][number]) => boolean, n = 12) =>
    tl.messages.filter((m) => m.ms <= snap.t && filter(m)).slice(-n).reverse();
  const back = (
    <button type="button" onClick={() => onSelect(null)} className="mb-2 text-xs text-muted-foreground underline">
      ← overview
    </button>
  );

  if (selected?.kind === "agent") {
    const a = tl.byKey.get(selected.key);
    const s = snap.agents.get(selected.key);
    if (!a) return back;
    const events = a.events.filter((e) => e.ms <= snap.t).slice(-25).reverse();
    const held = [...snap.holders.entries()].filter(([, h]) => h.includes(a.key)).map(([k]) => k);
    return (
      <div>
        {back}
        <div className="flex items-center gap-2 text-base font-semibold">
          {dot(a.key)} {a.name}
        </div>
        <p className="text-xs text-muted-foreground">
          {a.role} · {s?.busy ? "busy" : "idle"} · {a.node.shortId}
          {a.node.gitBranch ? ` · ${a.node.gitBranch}` : ""}
        </p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">{a.node.cwd}</p>
        {s?.task && (
          <>
            <H>Task</H>
            <button type="button" className="text-left text-sm hover:underline" onClick={() => onSelect({ kind: "task", key: s.task!.key })}>
              <span style={{ color: TASK_COLORS[s.task.state] }}>{s.task.id ?? "task"} · {s.task.state.replace("_", " ")}</span> {s.task.title}
            </button>
          </>
        )}
        <H>Holds ({held.length})</H>
        <ul className="space-y-0.5">
          {held.map((k) => (
            <li key={k}>
              <button type="button" onClick={() => onSelect({ kind: "file", key: k })} className="truncate font-mono text-[11px] hover:underline">
                {k.split("\n")[1]}
              </button>
            </li>
          ))}
        </ul>
        <H>Tool calls</H>
        <ul className="space-y-0.5 font-mono text-[11px]">
          {events.map((e, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-muted-foreground">{new Date(e.ms).toLocaleTimeString()}</span>
              <span style={{ color: TOOL_COLORS[toolKind(e.tool)] }}>{e.tool}</span>
              {e.path && <span className="truncate">{e.path}</span>}
            </li>
          ))}
        </ul>
        <H>Messages</H>
        <MsgList tl={tl} onOpen={onOpen} list={recentMsgs((m) => m.from === a.key || m.to === a.key)} />
      </div>
    );
  }

  if (selected?.kind === "file") {
    const [repo, p] = selected.key.split("\n");
    const holders = snap.holders.get(selected.key) ?? [];
    const claims = tl.claims.filter((c) => c.fileKey === selected.key && c.ms <= snap.t).reverse();
    const edits = tl.edits.filter((e) => e.fileKey === selected.key && e.ms <= snap.t).slice(-10).reverse();
    const dirty = tl.repos.find((r) => r.id === repo)?.dirty.some((d) => d.p === p);
    return (
      <div>
        {back}
        <p className="font-mono text-sm break-all">{p}</p>
        <p className="font-mono text-[11px] text-muted-foreground">{repo}{dirty ? " · uncommitted changes" : ""}</p>
        <H>Held by</H>
        <p className="text-xs">
          {holders.length === 0 ? "nobody" : holders.map((h) => (
            <span key={h} className="mr-2 inline-flex items-center gap-1">
              {dot(h)} {name(h)}
            </span>
          ))}
          {holders.length > 1 && <span className="text-destructive"> clash</span>}
        </p>
        <H>Claims</H>
        <ul className="space-y-0.5 text-xs">
          {claims.map((c, i) => (
            <li key={i} className="flex items-center gap-1">
              {dot(c.node)} {name(c.node)} {c.action} · {formatRelativeTime(new Date(c.ms))}
            </li>
          ))}
        </ul>
        <H>Edits</H>
        <ul className="space-y-0.5 text-xs">
          {edits.map((e, i) => (
            <li key={i}>
              {e.node ? name(e.node) : "changed on disk"} · {formatRelativeTime(new Date(e.ms))}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (selected?.kind === "task") {
    const task = tl.tasks.find((x) => x.key === selected.key);
    if (!task) return back;
    return (
      <div>
        {back}
        <p className="font-semibold">
          {task.id ?? "Task"} {task.title}
        </p>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          {dot(task.manager)} {name(task.manager)} → {dot(task.worker)} {name(task.worker)}
          {task.guessed ? " · guessed" : ""}
        </p>
        <H>History</H>
        <ul className="space-y-0.5 text-xs">
          {task.events
            .filter((e) => e.ms <= snap.t)
            .map((e, i) => (
              <li key={i}>
                <span style={{ color: TASK_COLORS[e.state] }}>{e.state.replace("_", " ")}</span> · {formatRelativeTime(new Date(e.ms))}
                {e.text ? ` · ${e.text}` : ""}
              </li>
            ))}
        </ul>
      </div>
    );
  }

  if (selected?.kind === "commit") {
    const c = tl.commits.find((x) => x.hash === selected.hash);
    if (!c) return back;
    return (
      <div>
        {back}
        <p className="font-mono">{c.abbrev}</p>
        <p className="text-sm">{c.subject ?? "(not in the repo)"}</p>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          {dot(c.node)} {name(c.node)} · {formatRelativeTime(new Date(c.ms))}
          {c.remote ? " · on the remote" : " · local only"}
        </p>
      </div>
    );
  }

  // Overview
  const open = snap.tasks.filter((x) => x.state !== "done").sort((a, b) => b.since - a.since);
  const clashes = [...snap.holders.entries()].filter(([, h]) => h.length > 1);
  return (
    <div>
      <H>Agents</H>
      <ul className="space-y-1">
        {tl.agents.map((a) => {
          const s = snap.agents.get(a.key);
          return (
            <li key={a.key}>
              <button type="button" onClick={() => onSelect({ kind: "agent", key: a.key })} className="flex w-full items-center gap-2 text-left text-xs hover:underline">
                {dot(a.key)} <span className="font-medium">{a.name}</span>
                <span className="text-muted-foreground">{a.role}</span>
                <span className={s?.busy ? "text-amber-500" : "text-muted-foreground"}>{s?.busy ? (s.lastTool ?? "busy") : "idle"}</span>
                {s?.task?.id && <span className="ml-auto font-mono" style={{ color: TASK_COLORS[s.task.state] }}>{s.task.id}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {clashes.length > 0 && (
        <>
          <H>Clashes</H>
          <ul className="space-y-0.5 text-xs text-destructive">
            {clashes.map(([k, h]) => (
              <li key={k}>
                <button type="button" onClick={() => onSelect({ kind: "file", key: k })} className="hover:underline">
                  {k.split("\n")[1]}: {h.map(name).join(" + ")}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <H>Open tasks ({open.length})</H>
      <ul className="space-y-1 text-xs">
        {open.slice(0, 12).map((x) => (
          <li key={x.key}>
            <button type="button" onClick={() => onSelect({ kind: "task", key: x.key })} className="text-left hover:underline">
              <span className="font-mono" style={{ color: TASK_COLORS[x.state] }}>
                {x.id ?? "·"} {x.state.replace("_", " ")}
              </span>{" "}
              {x.title}
            </button>
          </li>
        ))}
      </ul>
      <H>Latest messages</H>
      <MsgList tl={tl} onOpen={onOpen} list={recentMsgs(() => true)} />
      <p className="mt-3 text-[10px] text-muted-foreground">
        Files touched with Edit/Write/Read are known exactly. Most edits go through Bash, so files with uncommitted
        changes pulse when their modification time moves, credited to the holder or the busy agent in that repo.
      </p>
    </div>
  );
}

function H({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-3 mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{children}</h3>;
}

function Dot({ tl, k }: { tl: Timeline; k: string }) {
  return <span className="inline-block size-2 rounded-full" style={{ background: tl.byKey.get(k)?.color ?? "gray" }} />;
}

function MsgList({ tl, list, onOpen }: { tl: Timeline; list: Timeline["messages"]; onOpen: (id: string) => void }) {
  const name = (k: string) => tl.byKey.get(k)?.name ?? "?";
  return (
    <ul className="space-y-1">
      {list.map((m) => (
        <li key={m.id}>
          <button type="button" onClick={() => onOpen(m.id)} className="w-full rounded px-1 py-0.5 text-left text-xs hover:bg-muted">
            <span className="flex items-center gap-1 text-muted-foreground">
              <Dot tl={tl} k={m.from} /> {name(m.from)} → <Dot tl={tl} k={m.to} /> {name(m.to)} ·{" "}
              {formatRelativeTime(new Date(m.ms))}
            </span>
            <span className="line-clamp-2" style={{ borderLeft: `2px solid ${m.color}`, paddingLeft: 6 }}>
              {m.label}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Toolbar dropdown: tick the projects to show; All / None, and "only" per row. */
function ProjectsFilter({
  projects,
  hidden,
  onChange,
}: {
  projects: ProjectInfo[];
  hidden: Set<string>;
  onChange: (hidden: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const shown = projects.filter((p) => !hidden.has(p.id)).length;
  const toggle = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  return (
    <div className="relative">
      <Button size="sm" variant="outline" onClick={() => setOpen(!open)} aria-expanded={open}>
        Projects {projects.length ? `${shown}/${projects.length}` : ""}
      </Button>
      {open && (
        <>
          <button type="button" aria-label="Close" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 z-50 mt-1 w-80 rounded-md border bg-popover p-1 text-sm shadow-lg">
            <div className="flex gap-2 border-b px-2 py-1 text-xs">
              <button type="button" className="hover:underline" onClick={() => onChange(new Set())}>
                All
              </button>
              <button type="button" className="hover:underline" onClick={() => onChange(new Set(projects.map((p) => p.id)))}>
                None
              </button>
            </div>
            <ul className="max-h-80 overflow-auto py-1">
              {projects.map((p) => (
                <li key={p.id} className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-muted">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2" title={p.id}>
                    <input type="checkbox" checked={!hidden.has(p.id)} onChange={() => toggle(p.id)} />
                    <span className="truncate font-medium">{p.name}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {p.agents} agent{p.agents === 1 ? "" : "s"} · {p.activity} calls
                    </span>
                  </label>
                  <button
                    type="button"
                    className="invisible shrink-0 text-[11px] text-primary group-hover:visible hover:underline"
                    onClick={() => onChange(new Set(projects.filter((x) => x.id !== p.id).map((x) => x.id)))}
                  >
                    only
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
