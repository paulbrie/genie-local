"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  Bot,
  Box,
  ChefHat,
  ChevronDown,
  Code2,
  Container,
  Database,
  ExternalLink,
  Globe,
  KanbanSquare,
  KeyRound,
  LayoutDashboard,
  LogOut,
  UsersRound,
  MessagesSquare,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  FolderOpen,
  FolderKanban,
  ScrollText,
  Server,
  Share2,
  Sparkles,
  SquareTerminal,
  TrainFront,
  Workflow,
  X,
} from "lucide-react";
import { useSubject } from "subjecto/react";

import type { WispMotion } from "@/brand/spiridus";
import { Lockup, Wisp } from "@/components/brand/wisp";
import { ClaudeGlyph, claudeGlyphState } from "@/components/claude-glyph";
import { ProjectContextMenu } from "@/components/project-context-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { StatusDot } from "@/components/ui/status-dot";
import { BASE_PATH } from "@/lib/config";
import type { ProjectNavItem } from "@/lib/dashboard-metrics";
import { useIsMobile } from "@/lib/use-is-mobile";
import { activeRuns, openRun } from "@/store/runs";
import { mobileNav } from "@/store/ui";
import {
  liveTerminals,
  openTerminal,
  type TermStatus,
} from "@/store/terminals";

type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  exact?: boolean;
  /** A collapsible group: the item itself links to its own page, these under it. */
  children?: NavItem[];
};

const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
  // Its sub-items are the projects themselves (ProjectsGroup), loaded live.
  { href: "/projects", label: "Projects", icon: FolderKanban, exact: true },
  { href: "/processes", label: "Processes", icon: Activity },
  { href: "/chrome", label: "Chrome", icon: Globe },
  { href: "/terminals", label: "Terminals", icon: SquareTerminal },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/docker", label: "Docker", icon: Container },
  { href: "/services", label: "Services", icon: Server },
  { href: "/nginx", label: "Nginx", icon: Network },
  { href: "/railway", label: "Railway", icon: TrainFront },
  { href: "/db", label: "DB Explorer", icon: Database },
  { href: "/diagrams", label: "Diagrams", icon: Share2 },
  { href: "/recipes", label: "Recipes", icon: ChefHat },
  { href: "/files", label: "Files", icon: FolderOpen },
  { href: "/logs", label: "Logs", icon: ScrollText },
  { href: "/logins", label: "Logins", icon: KeyRound },
  { href: "/claude", label: "Claude", icon: Sparkles },
  {
    href: "/teams",
    label: "Team",
    icon: UsersRound,
    exact: true,
    children: [
      { href: "/comms", label: "Comms", icon: MessagesSquare },
      { href: "/agents3d", label: "Agents City", icon: Box },
      { href: "/tasks", label: "Tasks", icon: KanbanSquare },
    ],
  },
];

const STORAGE_KEY = "admin.sidebar.collapsed";
/** The nav groups folded shut (by href); open by default. */
const GROUPS_KEY = "admin.sidebar.closedGroups";

const isActive = (item: NavItem, pathname: string) =>
  item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);

/**
 * Collapsible left navigation rail. Holds every top-level route plus the global
 * theme + logout controls. Collapsed/expanded state persists in localStorage.
 */
export function AppSidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen] = useSubject(mobileNav);
  const isMobile = useIsMobile();
  // The icon-rail collapse is a desktop affordance; on mobile the sidebar is a
  // full-width off-canvas drawer, so it never uses the rail.
  const rail = collapsed && !isMobile;
  const closeMobile = () => mobileNav.next(false);
  const [chromeCount, setChromeCount] = useState<number | null>(null);
  const [dockerStats, setDockerStats] = useState<{
    running: number;
    memBytes: number;
  } | null>(null);
  const [runs] = useSubject(activeRuns);
  // Currently-active runs (kept fresh by <RunDock>), shown as sub-items.
  const liveRuns = runs.filter(
    (r) => r.running || r.state === "running" || r.state === "starting",
  );
  const [terms] = useSubject(liveTerminals);
  // "Currently working" = anything not sitting idle at a shell prompt.
  const workingTerms = terms.filter((t) => t.status !== "idle");

  // The wisp's state (brand motion): looking for you while an agent waits on
  // you, flickering while one works, else idle blinking; a wink on hover.
  const waitingOn = terms.filter((t) => t.status === "claude-input").length;
  const working = terms.filter((t) => t.status === "claude-working").length;
  const [winking, setWinking] = useState(false);
  const wink = () => {
    if (winking) return;
    setWinking(true);
    setTimeout(() => setWinking(false), 900);
  };
  const wispMotion: WispMotion = winking ? "wink" : waitingOn ? "look" : working ? "flicker" : "blink";
  const wispTitle = waitingOn
    ? `${waitingOn} agent${waitingOn === 1 ? " is" : "s are"} waiting for you`
    : working
      ? `${working} agent${working === 1 ? "" : "s"} working`
      : "All quiet";

  const [closedGroups, setClosedGroups] = useState<string[]>([]);

  // Restore persisted state after mount (avoids SSR/client mismatch).
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(STORAGE_KEY) === "1");
      const g = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "[]");
      if (Array.isArray(g)) setClosedGroups(g.filter((x): x is string => typeof x === "string"));
    } catch {
      /* private mode / no storage — keep default */
    }
  }, []);

  const toggleGroup = (href: string) =>
    setClosedGroups((cur) => {
      const next = cur.includes(href) ? cur.filter((h) => h !== href) : [...cur, href];
      try {
        localStorage.setItem(GROUPS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });

  // Live count of running Chrome instances, shown as a badge on the nav item.
  useEffect(() => {
    if (pathname === "/login") return;
    let active = true;
    const load = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/chrome`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const json = await res.json();
        if (active) setChromeCount((json.instances ?? []).length);
      } catch {
        /* ignore */
      }
    };
    void load();
    const id = setInterval(load, 7000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [pathname]);

  // Live running-container count + memory, shown as a badge on the Docker item.
  // `docker stats` is slower than a plain list, so this polls on its own timer.
  useEffect(() => {
    if (pathname === "/login") return;
    let active = true;
    const load = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/docker/stats`, {
          cache: "no-store",
        });
        if (!res.ok) {
          if (active) setDockerStats(null);
          return;
        }
        const json = await res.json();
        if (active)
          setDockerStats({
            running: json.running ?? 0,
            memBytes: json.memBytes ?? 0,
          });
      } catch {
        /* ignore */
      }
    };
    void load();
    const id = setInterval(load, 10000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [pathname]);

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  async function logout() {
    await fetch(`${BASE_PATH}/api/logout`, { method: "POST" }).catch(() => {});
    window.location.assign(`${BASE_PATH}/login`);
  }

  // The login page renders without app chrome.
  if (pathname === "/login") return null;

  return (
    <>
      {/* Scrim behind the mobile drawer (below md only). */}
      {mobileOpen && (
        <div
          onClick={closeMobile}
          aria-hidden
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex h-screen w-60 shrink-0 flex-col border-r bg-background/95 transition-transform duration-200 md:static md:z-auto md:transition-[width] ${
          rail ? "md:w-14" : "md:w-56"
        } ${mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}`}
      >
        <div className={`flex h-10 shrink-0 items-center gap-2 border-b ${rail ? "justify-center px-2" : "px-3"}`}>
          {/* The Spiridus lockup (mark only on the rail, where it expands the
              sidebar). The wisp shows the agents' state; winks on hover. */}
          {rail ? (
            <button
              type="button"
              onClick={toggle}
              onMouseEnter={wink}
              aria-label="Expand sidebar"
              title="Spiridus · expand"
              className="hidden rounded-md p-0.5 md:block"
            >
              <Wisp size={22} motion={wispMotion} title="" />
            </button>
          ) : (
            <Link
              href="/"
              onClick={closeMobile}
              onMouseEnter={wink}
              aria-label="Spiridus · Dashboard"
              title={wispTitle}
              className="flex min-w-0 flex-1 items-center"
            >
              <Lockup size={20} motion={wispMotion} />
            </Link>
          )}
          {/* Collapse toggle — desktop only (on the rail the wisp expands). */}
          <button
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand" : "Collapse"}
            className={`ml-auto text-muted-foreground transition-colors hover:text-foreground ${rail ? "hidden" : "hidden md:block"}`}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </button>
          {/* Close — mobile drawer only. */}
          <button
            onClick={closeMobile}
            aria-label="Close navigation"
            className="ml-auto text-muted-foreground transition-colors hover:text-foreground md:hidden"
          >
            <X className="size-5" />
          </button>
        </div>

      {/* Scrollbar hidden at rest, shown on hover (globals.css scrollbar-hover). */}
      <nav className="scrollbar-hover flex flex-1 flex-col gap-px overflow-y-auto p-1.5">
        {NAV.map((item) => {
          if (item.href === "/projects")
            return (
              <ProjectsGroup
                key={item.href}
                item={item}
                pathname={pathname}
                rail={rail}
                open={!closedGroups.includes(item.href) || pathname.startsWith("/projects/")}
                onToggle={() => toggleGroup(item.href)}
                onNavigate={closeMobile}
              />
            );
          if (item.children)
            return (
              <NavGroup
                key={item.href}
                item={item}
                pathname={pathname}
                rail={rail}
                // a group with the page you're on stays open
                open={!closedGroups.includes(item.href) || item.children.some((c) => isActive(c, pathname))}
                onToggle={() => toggleGroup(item.href)}
                onNavigate={closeMobile}
              />
            );
          const active = isActive(item, pathname);
          const Icon = item.icon;
          // Numeric count drives the collapsed-rail pill; Docker also gets a
          // wider text badge (count · memory) in the expanded sidebar.
          const badge =
            item.href === "/chrome" && chromeCount
              ? chromeCount
              : item.href === "/agents" && liveRuns.length
                ? liveRuns.length
                : item.href === "/terminals" && workingTerms.length
                  ? workingTerms.length
                  : item.href === "/docker" && dockerStats?.running
                    ? dockerStats.running
                    : null;
          const badgeText =
            item.href === "/docker" && dockerStats?.running
              ? `${dockerStats.running} · ${fmtBytes(dockerStats.memBytes)}`
              : badge;
          return (
            <div key={item.href}>
              <Link
                href={item.href}
                onClick={closeMobile}
                aria-current={active ? "page" : undefined}
                title={
                  rail
                    ? `${item.label}${badge ? ` (${badge})` : ""}`
                    : undefined
                }
                className={`relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] leading-5 transition-colors ${
                  rail ? "justify-center" : ""
                } ${
                  active
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                }`}
              >
                <Icon className="size-[15px] shrink-0" />
                {!rail && <span className="truncate">{item.label}</span>}
                {badge != null &&
                  (rail ? (
                    <span className="absolute -top-1 right-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
                      {badge}
                    </span>
                  ) : (
                    <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-xs font-medium whitespace-nowrap text-primary">
                      {badgeText}
                    </span>
                  ))}
              </Link>

              {/* Live agent/pipeline runs, as sub-items under Agents. Clicking
                  opens (or un-minimizes) the run's window in the global dock. */}
              {item.href === "/agents" && !rail && liveRuns.length > 0 && (
                <div className="mt-px flex flex-col gap-px">
                  {liveRuns.map((r) => {
                    const KindIcon = r.kind === "pipeline" ? Workflow : Bot;
                    return (
                      <button
                        key={r.runId}
                        type="button"
                        onClick={() => {
                          openRun(r.runId);
                          closeMobile();
                        }}
                        title={`Open ${r.name}${
                          r.kind === "pipeline"
                            ? ` — ${r.stepsDone}/${r.stepsTotal}`
                            : ""
                        }`}
                        className="flex items-center gap-2 rounded-md py-0.5 pr-2 pl-7 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                      >
                        <StatusDot color="bg-emerald-500" pulse size="sm" />
                        <KindIcon className="size-3 shrink-0 opacity-70" />
                        <span className="truncate">{r.name}</span>
                        {r.kind === "pipeline" && r.stepsTotal > 0 && (
                          <span className="ml-auto shrink-0 tabular-nums opacity-70">
                            {r.stepsDone}/{r.stepsTotal}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Currently-working terminals, as sub-items under Terminals.
                  Clicking opens (or un-minimizes) the tmux window in the dock. */}
              {item.href === "/terminals" &&
                !rail &&
                workingTerms.length > 0 && (
                  <div className="mt-px flex flex-col gap-px">
                    {workingTerms.map((t) => (
                      <button
                        key={t.name}
                        type="button"
                        onClick={() => {
                          openTerminal(t.name);
                          closeMobile();
                        }}
                        title={
                          t.tokens
                            ? `Open ${t.name} — ${termLabel(t.status)} · ↑ ${t.tokens.input.toLocaleString()} / ↓ ${t.tokens.output.toLocaleString()} tokens this session`
                            : `Open ${t.name} — ${termLabel(t.status)}`
                        }
                        className="flex items-center gap-2 rounded-md py-0.5 pr-2 pl-7 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                      >
                        <TermDot status={t.status} />
                        <span className="truncate">{t.name}</span>
                        {t.tokens && t.tokens.total > 0 && (
                          <span className="ml-auto shrink-0 font-mono tabular-nums opacity-70">
                            {fmtTokens(t.tokens.total)}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
            </div>
          );
        })}

        {/* VS Code (code-server) — lives outside the /admin basePath, so a raw
            <a> (Next <Link> would prefix it with basePath). Gated by the admin
            session cookie in nginx. */}
        <a
          href="/vscode/"
          target="_blank"
          rel="noreferrer"
          onClick={closeMobile}
          title={rail ? "VS Code" : undefined}
          className={`relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] leading-5 transition-colors ${
            rail ? "justify-center" : ""
          } text-muted-foreground hover:bg-accent/50 hover:text-foreground`}
        >
          <Code2 className="size-[15px] shrink-0" />
          {!rail && (
            <>
              <span className="truncate">VS Code</span>
              <ExternalLink className="ml-auto size-3.5 shrink-0 opacity-50" />
            </>
          )}
        </a>
      </nav>

        <div
          className={`flex shrink-0 items-center gap-1 border-t p-1.5 ${
            rail ? "flex-col" : ""
          }`}
        >
          <ThemeToggle />
          <button
            onClick={logout}
            title="Logout"
            className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] leading-5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground ${
              rail ? "justify-center" : "flex-1"
            }`}
          >
            <LogOut className="size-[15px] shrink-0" />
            {!rail && <span>Logout</span>}
          </button>
        </div>
      </aside>
    </>
  );
}

// Non-Claude terminal status → dot colour + optional pulse. Claude sessions use
// the glyph below instead, so only the plain shell states live here.
const TERM_DOT: Record<"idle" | "busy", { dot: string; ping: string | null }> = {
  idle: { dot: "bg-muted-foreground/40", ping: null },
  busy: { dot: "bg-emerald-500", ping: "bg-emerald-400" },
};

/** Compact byte size for the Docker badge: 1_610_612_736 → "1.5 GB". */
function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** Compact token count: 1_234 → "1.2k", 2_500_000 → "2.5M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function termLabel(status: TermStatus): string {
  switch (status) {
    case "claude-working":
      return "Claude is working";
    case "claude-input":
      return "Claude needs your input";
    case "claude-idle":
      return "Claude is idle";
    case "busy":
      return "Running a command";
    default:
      return "Idle";
  }
}

function TermDot({ status }: { status: TermStatus }) {
  // Claude sessions get the CLI glyph — twinkling while active, a steady dimmed
  // spark while idle, and a "?" when blocked on input — same as the dock.
  const claude = claudeGlyphState(status);
  if (claude) {
    return (
      <span
        role="img"
        aria-label={termLabel(status)}
        title={termLabel(status)}
        className="inline-flex size-2.5 items-center justify-center"
      >
        <ClaudeGlyph state={claude} size="sm" />
      </span>
    );
  }
  const { dot, ping } = status === "busy" ? TERM_DOT.busy : TERM_DOT.idle;
  return (
    <StatusDot color={dot} pulse={ping !== null} size="sm" label={termLabel(status)} />
  );
}

/**
 * A collapsible nav group: its row links to the group's own page (Team → the
 * Teams page), the chevron folds it, and its sub-items sit under it, the one
 * you're on highlighted. On the icon rail the sub-items show as icons.
 */
function NavGroup({
  item,
  pathname,
  rail,
  open,
  onToggle,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  rail: boolean;
  open: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  const active = isActive(item, pathname);
  const row = (it: NavItem, sub: boolean) => {
    const on = isActive(it, pathname);
    const ItIcon = it.icon;
    return (
      <Link
        key={it.href}
        href={it.href}
        onClick={onNavigate}
        aria-current={on ? "page" : undefined}
        title={rail ? it.label : undefined}
        className={`flex items-center gap-2.5 rounded-md text-[13px] leading-5 transition-colors ${
          rail ? "justify-center px-2.5 py-1.5" : sub ? "py-1 pr-2.5 pl-7" : "px-2.5 py-1.5"
        } ${
          on
            ? "bg-accent font-medium text-accent-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        }`}
      >
        <ItIcon className={`shrink-0 ${sub && !rail ? "size-3.5" : "size-[15px]"}`} />
        {!rail && <span className="truncate">{it.label}</span>}
      </Link>
    );
  };
  if (rail)
    return (
      <div className="flex flex-col gap-px">
        {row(item, false)}
        {item.children!.map((c) => row(c, true))}
      </div>
    );
  return (
    <div>
      <div
        className={`flex items-center rounded-md transition-colors ${
          active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        }`}
      >
        <Link
          href={item.href}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          className={`flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-[13px] leading-5 ${active ? "font-medium" : ""}`}
        >
          <Icon className="size-[15px] shrink-0" />
          <span className="truncate">{item.label}</span>
        </Link>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`${open ? "Fold" : "Unfold"} ${item.label}`}
          title={open ? "Fold" : "Unfold"}
          className="mr-1 rounded p-0.5 opacity-70 hover:bg-accent hover:opacity-100"
        >
          <ChevronDown className={`size-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />
        </button>
      </div>
      {open && <div className="mt-px flex flex-col gap-px">{item.children!.map((c) => row(c, true))}</div>}
    </div>
  );
}

/**
 * Projects, with the projects as its sub-items (like the terminals under
 * Terminals): a dot when one of its apps is running, and its tickets to do.
 * The list comes from /api/projects, refreshed on navigation and every 30 s.
 */
function ProjectsGroup({
  item,
  pathname,
  rail,
  open,
  onToggle,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  rail: boolean;
  open: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}) {
  const [list, setList] = useState<ProjectNavItem[] | null>(null);
  // Bumped after a script is started / stopped from a project's menu.
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/projects`, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { projects: ProjectNavItem[] };
        if (active) setList(json.projects);
      } catch {
        /* ignore: keep the last list */
      }
    };
    void load();
    // After a start / stop: now, and again once the server has bound its port.
    const soon = reload ? setTimeout(load, 2500) : undefined;
    const id = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(id);
      clearTimeout(soon);
    };
  }, [pathname, reload]);

  const Icon = item.icon;
  const active = isActive(item, pathname);
  const rowClass = (on: boolean) =>
    on ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground";

  // The icon rail has no room for a dozen names: just the Projects page.
  if (rail)
    return (
      <Link
        href={item.href}
        onClick={onNavigate}
        title={item.label}
        aria-current={active ? "page" : undefined}
        className={`flex items-center justify-center rounded-md px-2.5 py-1.5 transition-colors ${rowClass(active || pathname.startsWith("/projects/"))}`}
      >
        <Icon className="size-[15px] shrink-0" />
      </Link>
    );

  return (
    <div>
      <div className={`flex items-center rounded-md transition-colors ${rowClass(active)}`}>
        <Link
          href={item.href}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          className={`flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-[13px] leading-5 ${active ? "font-medium" : ""}`}
        >
          <Icon className="size-[15px] shrink-0" />
          <span className="truncate">{item.label}</span>
          {list && <span className="ml-auto text-xs tabular-nums opacity-60">{list.length}</span>}
        </Link>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`${open ? "Fold" : "Unfold"} ${item.label}`}
          title={open ? "Fold" : "Unfold"}
          className="mr-1 rounded p-0.5 opacity-70 hover:bg-accent hover:opacity-100"
        >
          <ChevronDown className={`size-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />
        </button>
      </div>
      {open && list && (
        <div className="mt-px flex flex-col gap-px">
          {list.map((p) => {
            const href = `/projects/${encodeURIComponent(p.slug)}`;
            const on = pathname === href || pathname.startsWith(`${href}/`);
            return (
              // Right-click: the project's tabs, and its scripts.
              <ProjectContextMenu
                key={p.slug}
                slug={p.slug}
                hasGit={p.hasGit}
                ports={p.ports ?? []}
                onNavigate={onNavigate}
                onChanged={() => setReload((n) => n + 1)}
              >
                <Link
                  href={href}
                  onClick={onNavigate}
                  aria-current={on ? "page" : undefined}
                  title={`${p.slug}${p.running ? ` · running${(p.ports ?? []).length ? ` on :${(p.ports ?? []).join(", :")}` : ""}` : ""} · ${p.openTasks} ticket${p.openTasks === 1 ? "" : "s"} to do${p.inProgress ? ` (${p.inProgress} in progress)` : ""}`}
                  className={`flex items-center gap-2 rounded-md py-0.5 pr-2 pl-7 text-xs transition-colors ${
                    on ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  }`}
                >
                  <StatusDot
                    color={p.running ? "bg-emerald-500" : "bg-muted-foreground/30"}
                    pulse={p.running}
                    size="sm"
                    label={p.running ? "Running" : "Not running"}
                  />
                  <span className="truncate">{p.slug}</span>
                  {(p.ports ?? []).length > 0 && (
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-emerald-700 dark:text-emerald-400">
                      :{(p.ports ?? []).join(" :")}
                    </span>
                  )}
                  {p.openTasks > 0 && (
                    <span className={`shrink-0 tabular-nums opacity-70 ${(p.ports ?? []).length > 0 ? "" : "ml-auto"}`}>
                      {p.openTasks}
                    </span>
                  )}
                </Link>
              </ProjectContextMenu>
            );
          })}
        </div>
      )}
    </div>
  );
}
