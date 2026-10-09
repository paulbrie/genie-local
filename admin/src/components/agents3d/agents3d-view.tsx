"use client";

import dynamic from "next/dynamic";
import { Armchair, Building2, ChevronDown, ChevronRight, Maximize2, Minimize2, PanelRightClose, PanelRightOpen } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSubject } from "subjecto/react";

import { commitHref } from "@/components/comms/comms-panels";
import type { NodeView } from "@/components/comms/comms-view";
import { MessageSheet } from "@/components/comms/message-sheet";
import { Button } from "@/components/ui/button";
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
import { isClosed } from "@/lib/claude-comms-parse";
import { TAG_COLORS } from "@/lib/comms-colors";
import { formatRelativeTime } from "@/lib/format";
import { commsPrefs, hydrateCommsPrefs, setCommsPrefs } from "@/store/comms";

import { Clock } from "./clock";
import { EditorTimeline } from "./timeline";
import type { SceneProps, Selection } from "./scene";
import { useAgents3D } from "./use-agents3d";
import { type PaneView, usePanes } from "./use-panes";

const Scene = dynamic(() => import("./scene"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-white/60">Loading 3D…</div>,
});
const DeskScene = dynamic(() => import("./desk/desk-scene"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-white/60">Loading the desk…</div>,
});
const MODE_KEY = "admin.agents3d.mode";
const PANEL_KEY = "admin.agents3d.panel";
const FOLDS_KEY = "admin.agents3d.folds";

/** Time windows, with a replay speed that suits each. */
const WINDOWS = [
  { label: "1h", hours: 1, speed: 10 },
  { label: "8h", hours: 8, speed: 60 },
  { label: "1d", hours: 24, speed: 300 },
  { label: "3d", hours: 72, speed: 1200 },
  { label: "7d", hours: 168, speed: 3600 },
];
const WINDOW_KEY = "admin.agents3d.window";
const TERMINALS_KEY = "admin.agents3d.terminals";

function subscribeReduced(f: () => void) {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", f);
  return () => mq.removeEventListener("change", f);
}
const getReduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function subscribeFullscreen(f: () => void) {
  document.addEventListener("fullscreenchange", f);
  return () => document.removeEventListener("fullscreenchange", f);
}

/** The element is focused for typing (F shouldn't toggle full screen then). */
const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

const LINGER_KEY = "admin.agents3d.linger";

export function Agents3DView() {
  // Default 8h: the current working session; longer windows are for replay.
  const [hours, setHours] = useState(8);
  const [follow, setFollow] = useState("");
  const [bloomPref, setBloom] = useState<boolean | null>(null);
  // How long (s) bolts, flashes and edit pulses linger, fading, after an operation.
  const [lingerS, setLingerS] = useState(3);
  // Live terminal previews in the cards (tmux capture-pane, redacted on the server).
  const [terminals, setTerminals] = useState(true);
  useEffect(() => {
    if (localStorage.getItem(TERMINALS_KEY) === "0") setTerminals(false); // eslint-disable-line react-hooks/set-state-in-effect
  }, []);
  useEffect(() => {
    const w = Number(localStorage.getItem(WINDOW_KEY));
    if (WINDOWS.some((x) => x.hours === w)) setHours(w); // eslint-disable-line react-hooks/set-state-in-effect
  }, []);
  useEffect(() => {
    const saved = Number(localStorage.getItem(LINGER_KEY));
    if (localStorage.getItem(LINGER_KEY) !== null && saved >= 0 && saved <= 10) setLingerS(saved); // eslint-disable-line react-hooks/set-state-in-effect
  }, []);
  // City (drones over the repo cities) or Table (the Desk: clay characters seated around a table),
  // from the toolbar switch or T. Remembered; ?mode=desk / ?mode=city deep-link and win over the
  // remembered choice. Null until read, so the wrong world never mounts first. The clock, project
  // filter and selection live here, so switching keeps them.
  const [mode, setMode] = useState<"city" | "desk" | null>(null);
  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get("mode") ?? localStorage.getItem(MODE_KEY);
    setMode(m === "desk" ? "desk" : "city"); // eslint-disable-line react-hooks/set-state-in-effect
  }, []);
  const pickMode = (m: "city" | "desk") => {
    setMode(m);
    localStorage.setItem(MODE_KEY, m);
    // Keep a ?mode= deep link in step, so a reload stays in the chosen view.
    const url = new URL(window.location.href);
    if (url.searchParams.has("mode")) {
      url.searchParams.set("mode", m);
      window.history.replaceState(window.history.state, "", url);
    }
  };
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  });
  // The side panel: collapsed to a rail, and which of its sections are folded.
  const [panelOpen, setPanelOpen] = useState(true);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (localStorage.getItem(PANEL_KEY) === "0") setPanelOpen(false); // eslint-disable-line react-hooks/set-state-in-effect
    try {
      const f = JSON.parse(localStorage.getItem(FOLDS_KEY) ?? "[]");
      if (Array.isArray(f)) setFolded(new Set(f.filter((x) => typeof x === "string")));
    } catch {
      // ignore a malformed value
    }
  }, []);
  const togglePanel = () => {
    setPanelOpen(!panelOpen);
    localStorage.setItem(PANEL_KEY, panelOpen ? "0" : "1");
  };
  const toggleFold = (id: string) => {
    const next = new Set(folded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFolded(next);
    localStorage.setItem(FOLDS_KEY, JSON.stringify([...next]));
  };
  const [selected, setSelected] = useState<Selection | null>(null);
  // Clicking an agent's card or row: first click flies the camera to it, a second follows it.
  const [flyTo, setFlyTo] = useState<{ key: string; n: number } | null>(null);
  const onAgentClick = (key: string) => {
    if (flyTo?.key === key && selected?.kind === "agent" && selected.key === key) setFollow(key);
    else {
      setFollow("");
      setFlyTo({ key, n: (flyTo?.n ?? 0) + 1 });
    }
    setSelected({ kind: "agent", key });
  };
  const onSelect = (s: Selection | null) => {
    setSelected(s);
    if (!s) setFollow(""); // empty ground: back to the free camera
  };
  const [openMsg, setOpenMsg] = useState<string | null>(null);
  const [prefs] = useSubject(commsPrefs);
  const reduced = useSyncExternalStore(subscribeReduced, getReduced, () => false);
  const bloom = bloomPref ?? !reduced;

  // Full screen: the whole page (toolbar, scrubber, scene, side panel) via the
  // Fullscreen API, or a fixed full-viewport overlay where it's missing (iOS Safari).
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const [overlay, setOverlay] = useState(false);
  const native = useSyncExternalStore(
    subscribeFullscreen,
    () => !!rootEl && document.fullscreenElement === rootEl,
    () => false,
  );
  const full = native || overlay;
  const toggleFull = () => {
    if (full) {
      if (document.fullscreenElement) void document.exitFullscreen();
      setOverlay(false);
    } else if (rootEl && document.fullscreenEnabled && rootEl.requestFullscreen) {
      rootEl.requestFullscreen().catch(() => setOverlay(true));
    } else setOverlay(true);
  };
  const toggleRef = useRef(toggleFull);
  const pickModeRef = useRef(pickMode);
  useEffect(() => {
    toggleRef.current = toggleFull;
    pickModeRef.current = pickMode;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleRef.current();
      } else if ((e.key === "t" || e.key === "T") && modeRef.current) {
        e.preventDefault();
        pickModeRef.current(modeRef.current === "desk" ? "city" : "desk");
      } else if (e.key === "Escape") {
        setOverlay(false); // native full screen handles Esc itself
        setFollow(""); // and back to the free camera
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [clock] = useState(() => new Clock());
  useEffect(() => clock.start(), [clock]);
  useEffect(() => hydrateCommsPrefs(), []);
  const tick = useSyncExternalStore(clock.subscribe, clock.getTick, () => 0);

  const { model, error } = useAgents3D(hours, true);
  const pickWindow = (h: number) => {
    setHours(h);
    localStorage.setItem(WINDOW_KEY, String(h));
    clock.setSpeed(WINDOWS.find((w) => w.hours === h)?.speed ?? 60);
  };
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

  // Terminals: every agent when there are few; else only the selected and busy ones.
  const paneKeys = useMemo(() => {
    if (!tl || !snap) return [];
    const all = tl.agents.map((a) => a.key);
    if (all.length <= 8) return all;
    return all.filter((k) => (selected?.kind === "agent" && selected.key === k) || snap.agents.get(k)?.busy);
  }, [tl, snap, selected]);
  const panes = usePanes(paneKeys, terminals && clock.live);

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

  return (
    <div
      ref={setRootEl}
      className={
        full
          ? "fixed inset-0 z-[60] flex flex-col gap-3 overflow-hidden bg-background p-3"
          : "flex min-h-0 flex-1 flex-col gap-3"
      }
    >
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <ProjectsFilter
          projects={projects}
          hidden={hidden}
          onChange={(ids) => setCommsPrefs({ ...commsPrefs.getValue(), hiddenProjects: [...ids] })}
        />
        <div className="flex rounded-md border">
          {WINDOWS.map((w) => (
            <button
              key={w.label}
              type="button"
              onClick={() => pickWindow(w.hours)}
              className={`px-2 py-1 text-xs ${w.hours === hours ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60"}`}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div className="flex rounded-md border" role="group" aria-label="View (T)">
          {(
            [
              ["city", "City", Building2, "The 3D city of repos, with agents as drones"],
              ["desk", "Table", Armchair, "The agents seated around a table, with the cities as miniatures"],
            ] as const
          ).map(([m, label, Icon, title]) => (
            <button
              key={m}
              type="button"
              onClick={() => pickMode(m)}
              aria-pressed={mode === m}
              title={`${title} (T)`}
              className={`flex items-center gap-1 px-2 py-1 text-xs ${mode === m ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60"}`}
            >
              <Icon className="size-3.5" aria-hidden />
              {label}
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
            .filter((x) => !isClosed(x.state) && x.id)
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
        <label className="flex items-center gap-1 text-xs text-muted-foreground" title="Live tmux pane of each agent in its card (redacted)">
          <input
            type="checkbox"
            checked={terminals}
            onChange={(e) => {
              setTerminals(e.target.checked);
              localStorage.setItem(TERMINALS_KEY, e.target.checked ? "1" : "0");
            }}
          />
          Terminals
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground" title="How long lightning lingers, fading, after an operation">
          Linger
          <input
            type="range"
            aria-label="Linger seconds"
            min={0}
            max={10}
            step={0.5}
            value={lingerS}
            onChange={(e) => {
              const v = Number(e.target.value);
              setLingerS(v);
              localStorage.setItem(LINGER_KEY, String(v));
            }}
            className="w-20 accent-primary"
          />
          <span className="w-7 font-mono">{lingerS}s</span>
        </label>
        <Link href="/comms" className="ml-auto text-xs text-muted-foreground underline underline-offset-2">
          2D view: Comms
        </Link>
        <Button
          size="sm"
          variant="outline"
          onClick={toggleFull}
          title={full ? "Exit full screen (Esc or F)" : "Full screen (F)"}
          aria-label={full ? "Exit full screen" : "Full screen"}
        >
          {full ? <Minimize2 /> : <Maximize2 />}
        </Button>
      </div>

      {/* Editor-style timeline: transport, ruler, playhead, one track per agent */}
      {tl && snap && (
        <EditorTimeline
          tl={tl}
          snap={snap}
          clock={clock}
          hours={hours}
          reduced={reduced}
          onSelect={setSelected}
          onAgentClick={onAgentClick}
          onOpen={setOpenMsg}
        />
      )}

      <div
        className={`grid min-h-0 flex-1 grid-cols-1 gap-3 ${
          // Collapsed, the panel is a thin rail and the scene takes the width (the canvas resizes itself).
          panelOpen ? "xl:grid-cols-[minmax(0,1fr)_22rem]" : "xl:grid-cols-[minmax(0,1fr)_2.5rem]"
        } ${
          // In full screen on narrow screens the side panel stacks below: keep most height for the scene.
          full ? (panelOpen ? "grid-rows-[minmax(0,1fr)_minmax(0,30%)] xl:grid-rows-1" : "grid-rows-[minmax(0,1fr)_auto] xl:grid-rows-1") : ""
        }`}
      >
        <div
          className={`relative overflow-hidden rounded-md border bg-[#03050a] ${
            full ? "h-full min-h-0" : "h-[calc(100vh-15rem)] min-h-[28rem]"
          }`}
        >
          {error && <p className="absolute top-2 left-2 z-10 text-xs text-destructive">Error: {error}</p>}
          {tl && snap && mode ? (
            <SceneOrDesk
              mode={mode}
              tl={tl}
              snap={snap}
              clock={clock}
              layout={layout}
              frameKey={frameKey}
              followKey={followKey}
              bloom={bloom}
              linger={lingerS * 1000}
              reduced={reduced}
              selected={selected}
              onSelect={onSelect}
              flyTo={flyTo}
              onAgentClick={onAgentClick}
              panes={terminals ? panes : undefined}
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
        {panelOpen ? (
          <aside
            aria-label="Side panel"
            className={`relative min-h-0 overflow-auto rounded-md border p-3 text-sm ${full ? "h-full" : "max-h-[calc(100vh-15rem)]"}`}
          >
            <button
              type="button"
              onClick={togglePanel}
              aria-expanded
              aria-label="Collapse the side panel"
              title="Collapse the side panel"
              className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted"
            >
              <PanelRightClose className="size-4" />
            </button>
            {tl && snap && (
              <SidePanel
                tl={tl}
                snap={snap}
                selected={selected}
                onSelect={setSelected}
                onOpen={setOpenMsg}
                onAgentClick={onAgentClick}
                panes={terminals ? panes : undefined}
                live={clock.live}
                folded={folded}
                onFold={toggleFold}
              />
            )}
          </aside>
        ) : (
          <aside aria-label="Side panel (collapsed)" className="flex min-h-0 justify-center rounded-md border p-1 xl:items-start">
            <button
              type="button"
              onClick={togglePanel}
              aria-expanded={false}
              aria-label="Expand the side panel"
              title="Expand the side panel"
              className="flex items-center gap-1 rounded px-1 py-1.5 text-xs text-muted-foreground hover:bg-muted xl:flex-col"
            >
              <PanelRightOpen className="size-4" />
              <span className="xl:[writing-mode:vertical-rl]">Agents · tasks · messages</span>
            </button>
          </aside>
        )}
      </div>

      <MessageSheet
        message={message}
        byKey={byKey}
        commits={commitLinks}
        onClose={() => setOpenMsg(null)}
        // In full screen only the fullscreen element is shown, so the sheet must render inside it.
        container={full ? rootEl : null}
      />
    </div>
  );
}

/** The City or the Desk: the same props, a different world. */
function SceneOrDesk({ mode, ...props }: SceneProps & { mode: "city" | "desk" }) {
  return mode === "desk" ? <DeskScene {...props} /> : <Scene {...props} />;
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
    ["maybe held (guessed)", "#94a3b8"],
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
  onAgentClick,
  panes,
  live,
  folded,
  onFold,
}: {
  tl: Timeline;
  snap: Snapshot;
  selected: Selection | null;
  onSelect: (s: Selection | null) => void;
  onOpen: (id: string) => void;
  onAgentClick: (key: string) => void;
  panes?: Record<string, PaneView>;
  live: boolean;
  /** Overview sections folded to their heading. */
  folded: Set<string>;
  onFold: (id: string) => void;
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
    const maybeHeld = [...snap.maybe.entries()].filter(([, h]) => h.includes(a.key)).map(([k]) => k);
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
          {maybeHeld.map((k) => (
            <li key={k} className="text-muted-foreground" title="Guessed from a message before tags were used">
              <button type="button" onClick={() => onSelect({ kind: "file", key: k })} className="truncate font-mono text-[11px] hover:underline">
                {k.split("\n")[1]} <span className="font-sans">(maybe)</span>
              </button>
            </li>
          ))}
        </ul>
        {panes && (
          <>
            <H>Terminal</H>
            {!live ? (
              <p className="text-xs text-muted-foreground">Live only: terminals aren&apos;t recorded for replay.</p>
            ) : panes[a.key]?.text != null ? (
              <>
                <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  {panes[a.key].pane} · captured {new Date(panes[a.key].at).toLocaleTimeString()}
                </p>
                <pre className="mt-1 max-h-72 overflow-auto rounded border bg-black/80 p-2 font-mono text-[10px] leading-[1.25] text-slate-100">
                  {panes[a.key].text}
                </pre>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No terminal (not in tmux).</p>
            )}
          </>
        )}
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
    const maybe = snap.maybe.get(selected.key) ?? [];
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
          {holders.length === 0 && maybe.length === 0
            ? "nobody"
            : holders.map((h) => (
                <span key={h} className="mr-2 inline-flex items-center gap-1">
                  {dot(h)} {name(h)}
                </span>
              ))}
          {holders.length > 1 && <span className="text-destructive"> clash</span>}
          {maybe.map((h) => (
            <span key={h} className="mr-2 inline-flex items-center gap-1 text-muted-foreground" title="Guessed from a message before tags were used">
              {dot(h)} {name(h)} (maybe)
            </span>
          ))}
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
        <p
          className={`font-semibold ${
            snap.tasks.find((x) => x.key === task.key)?.state === "cancelled" ? "text-muted-foreground line-through" : ""
          }`}
        >
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
  const open = snap.tasks.filter((x) => !isClosed(x.state)).sort((a, b) => b.since - a.since);
  const clashes = [...snap.holders.entries()].filter(([, h]) => h.length > 1);
  const latest = recentMsgs(() => true);
  const fold = (id: string, label: string, count: number) => (
    <Fold id={id} label={label} count={count} open={!folded.has(id)} onToggle={onFold} />
  );
  return (
    <div>
      {fold("agents", "Agents", tl.agents.length)}
      {!folded.has("agents") && (
        <ul className="space-y-1">
          {tl.agents.map((a) => {
            const s = snap.agents.get(a.key);
            return (
              <li key={a.key}>
                <button
                  type="button"
                  onClick={() => onAgentClick(a.key)}
                  title="Fly to this agent; click again to follow it"
                  className="flex w-full items-center gap-2 text-left text-xs hover:underline"
                >
                  {dot(a.key)} <span className="font-medium">{a.name}</span>
                  <span className="text-muted-foreground">{a.role}</span>
                  <span className={s?.busy ? "text-amber-500" : "text-muted-foreground"}>{s?.busy ? (s.lastTool ?? "busy") : "idle"}</span>
                  {s?.task?.id && <span className="ml-auto font-mono" style={{ color: TASK_COLORS[s.task.state] }}>{s.task.id}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {clashes.length > 0 && (
        <>
          {fold("clashes", "Clashes", clashes.length)}
          {!folded.has("clashes") && (
            <ul className="space-y-0.5 text-xs text-destructive">
              {clashes.map(([k, h]) => (
                <li key={k}>
                  <button type="button" onClick={() => onSelect({ kind: "file", key: k })} className="hover:underline">
                    {k.split("\n")[1]}: {h.map(name).join(" + ")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {fold("tasks", "Open tasks", open.length)}
      {!folded.has("tasks") && (
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
      )}
      {fold("messages", "Latest messages", latest.length)}
      {!folded.has("messages") && <MsgList tl={tl} onOpen={onOpen} list={latest} />}
      <p className="mt-3 text-[10px] text-muted-foreground">
        Files touched with Edit/Write/Read are known exactly. Most edits go through Bash, so files with uncommitted
        changes pulse when their modification time moves, credited to the holder or the busy agent in that repo.
      </p>
    </div>
  );
}

/** An overview section's heading: click (or Enter/Space) to fold it; the count stays visible. */
function Fold({ id, label, count, open, onToggle }: { id: string; label: string; count: number; open: boolean; onToggle: (id: string) => void }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <h3 className="mt-3 mb-1 first:mt-0">
      <button
        type="button"
        onClick={() => onToggle(id)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
      >
        <Chevron className="size-3.5" aria-hidden />
        {label} ({count})
      </button>
    </h3>
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
