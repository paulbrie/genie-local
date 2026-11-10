"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Bot,
  ChevronDown,
  Code2,
  ExternalLink,
  LogOut,
  MemoryStick,
  PanelLeftClose,
  PanelLeftOpen,
  FolderPlus,
  Workflow,
  X,
} from "lucide-react";
import { useSubject } from "subjecto/react";

import { Lockup, Wisp } from "@/components/brand/wisp";
import { fmtTokens, memoryTitle, shortBytes, termLabel, TermDot } from "@/components/nav-status";
import { isActive, NAV, type NavItem } from "@/components/nav-items";
import { NewProjectDialog } from "@/components/new-project-dialog";
import { ProjectContextMenu } from "@/components/project-context-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { TerminalContextMenu } from "@/components/terminal-context-menu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { StatusDot } from "@/components/ui/status-dot";
import { BASE_PATH } from "@/lib/config";
import type { ProjectNavItem } from "@/lib/dashboard-metrics";
import { useIsMobile } from "@/lib/use-is-mobile";
import { useNavBadges, useWispState } from "@/lib/use-nav-badges";
import { memoryOf, projectMemory } from "@/store/project-memory";
import { hydrateRecentBoards, recentBoards, syncRecentBoards } from "@/store/recent-boards";
import { openRun } from "@/store/runs";
import { mobileNav } from "@/store/ui";
import { openTerminal } from "@/store/terminals";

const STORAGE_KEY = "admin.sidebar.collapsed";
/** The nav groups folded shut (by href); open by default. */
const GROUPS_KEY = "admin.sidebar.closedGroups";

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
  const { dockerStats, liveRuns, workingTerms, badgeOf } = useNavBadges(pathname);
  const [boards] = useSubject(recentBoards);
  // The boards last opened on this browser, as sub-items under Boards: their
  // names refreshed (and archived ones dropped) from the board list.
  useEffect(() => {
    hydrateRecentBoards();
    fetch(`${BASE_PATH}/api/boards`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => Array.isArray(list) && syncRecentBoards(list))
      .catch(() => {});
  }, []);
  const { motion: wispMotion, title: wispTitle, wink } = useWispState();

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
          const badge = badgeOf(item.href);
          const badgeText =
            item.href === "/docker" && dockerStats?.running
              ? `${dockerStats.running} · ${fmtBytes(dockerStats.memBytes)}`
              : badge;
          // Boards and Terminals fold their sub-items like Projects (the same remembered closedGroups)
          const subCount =
            item.href === "/boards" ? boards.length : item.href === "/terminals" ? workingTerms.length : 0;
          const foldable = !rail && subCount > 0;
          const folded = foldable && closedGroups.includes(item.href);
          return (
            <div key={item.href}>
              <div className="flex items-center">
              <Link
                href={item.href}
                onClick={closeMobile}
                aria-current={active ? "page" : undefined}
                title={
                  rail
                    ? `${item.label}${badge ? ` (${badge})` : ""}`
                    : undefined
                }
                className={`relative flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] leading-5 transition-colors ${
                  rail ? "justify-center" : ""
                } ${
                  active
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                }`}
              >
                <Icon className="size-[15px] shrink-0" />
                {!rail && <span className="truncate">{item.label}</span>}
                {/* a foldable group counts what it lists, plainly, as Projects does; the pill is for live counts on plain rows and the rail */}
                {foldable && <span className="ml-auto text-xs tabular-nums opacity-60">{subCount}</span>}
                {badge != null && !foldable &&
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
              {foldable && (
                <button
                  type="button"
                  onClick={() => toggleGroup(item.href)}
                  aria-expanded={!folded}
                  aria-label={`${folded ? "Unfold" : "Fold"} ${item.label}`}
                  title={folded ? "Unfold" : "Fold"}
                  className="mr-1 rounded p-0.5 text-muted-foreground opacity-70 hover:bg-accent hover:opacity-100"
                >
                  <ChevronDown className={`size-3.5 transition-transform ${folded ? "-rotate-90" : ""}`} />
                </button>
              )}
              </div>

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

              {/* The boards last opened here, as sub-items under Boards. */}
              {item.href === "/boards" && !rail && !folded && boards.length > 0 && (
                <div className="mt-px flex flex-col gap-px">
                  {boards.map((b) => {
                    const here = pathname === `/boards/${b.id}`;
                    return (
                      <Link
                        key={b.id}
                        href={`/boards/${b.id}`}
                        onClick={closeMobile}
                        aria-current={here ? "page" : undefined}
                        title={b.title}
                        className={`flex items-center gap-2 rounded-md py-0.5 pr-2 pl-7 text-xs transition-colors ${
                          here
                            ? "font-medium text-foreground"
                            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                        }`}
                      >
                        <span className="truncate">{b.title}</span>
                      </Link>
                    );
                  })}
                </div>
              )}

              {/* Currently-working terminals, as sub-items under Terminals.
                  Clicking opens (or un-minimizes) the tmux window in the dock;
                  right-click: Open / Delete. */}
              {item.href === "/terminals" &&
                !rail &&
                !folded &&
                workingTerms.length > 0 && (
                  <div className="mt-px flex flex-col gap-px">
                    {workingTerms.map((t) => (
                      <TerminalContextMenu
                        key={t.name}
                        name={t.name}
                        claude={t.status.startsWith("claude")}
                        onNavigate={closeMobile}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            openTerminal(t.name);
                            closeMobile();
                          }}
                          title={
                            (t.tokens
                              ? `Open ${t.name} — ${termLabel(t.status)}${t.background ? ` (${t.background})` : ""} · ↑ ${t.tokens.input.toLocaleString()} / ↓ ${t.tokens.output.toLocaleString()} tokens this session`
                              : `Open ${t.name} — ${termLabel(t.status)}${t.background ? ` (${t.background})` : ""}`) +
                            (t.memBytes ? ` · ${shortBytes(t.memBytes)} in memory` : "")
                          }
                          className="flex w-full min-w-0 items-center gap-2 rounded-md py-0.5 pr-2 pl-7 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                        >
                          <TermDot status={t.status} />
                          <span className="min-w-0 truncate">{t.name}</span>
                          {t.tokens && t.tokens.total > 0 && (
                            <span className="ml-auto shrink-0 font-mono tabular-nums opacity-70">
                              {fmtTokens(t.tokens.total)}
                            </span>
                          )}
                          {/* what it and everything it started have in memory (PSS) */}
                          {!!t.memBytes && (
                            <span
                              className={`flex shrink-0 items-center gap-0.5 font-mono text-[10px] tabular-nums opacity-70 ${t.tokens && t.tokens.total > 0 ? "" : "ml-auto"}`}
                              data-testid={`terminal-mem-${t.name}`}
                            >
                              <MemoryStick className="size-2.5" />
                              {shortBytes(t.memBytes)}
                            </span>
                          )}
                        </button>
                      </TerminalContextMenu>
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

/** Compact byte size for the Docker badge: 1_610_612_736 → "1.5 GB". */
function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
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
  const [memory] = useSubject(projectMemory);
  // Bumped after a script is started / stopped from a project's menu, or a project is created.
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState(false);
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

  // Right-click on Projects (the row, or its icon in the rail): New project.
  const withMenu = (trigger: React.ReactNode) => (
    <>
      <ContextMenu>
        <ContextMenuTrigger>{trigger}</ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <ContextMenuItem onClick={() => setCreating(true)}>
            <FolderPlus /> New project…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} onCreated={() => setReload((n) => n + 1)} />}
    </>
  );

  // The icon rail has no room for a dozen names: just the Projects page.
  if (rail)
    return withMenu(
      <Link
        href={item.href}
        onClick={onNavigate}
        title={item.label}
        aria-current={active ? "page" : undefined}
        className={`flex items-center justify-center rounded-md px-2.5 py-1.5 transition-colors ${rowClass(active || pathname.startsWith("/projects/"))}`}
      >
        <Icon className="size-[15px] shrink-0" />
      </Link>,
    );

  return (
    <div>
      {withMenu(
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
        </div>,
      )}
      {open && list && (
        <div className="mt-px flex flex-col gap-px">
          {list.map((p) => {
            const href = `/projects/${encodeURIComponent(p.slug)}`;
            const on = pathname === href || pathname.startsWith(`${href}/`);
            // what it has in memory now (store/project-memory), red past its limit
            const mem = memoryOf(memory, p.slug);
            const limit = memory?.limits[p.slug];
            const over = !!mem && !!limit && mem.bytes > limit * 1024 * 1024;
            const memText = mem && mem.bytes > 0 ? shortBytes(mem.bytes) : null;
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
                  title={`${p.slug}${p.running ? ` · running${(p.ports ?? []).length ? ` on :${(p.ports ?? []).join(", :")}` : ""}` : ""}${mem ? ` · ${memoryTitle(mem)}${limit ? ` (limit ${shortBytes(limit * 1024 * 1024)})` : ""}` : ""} · ${p.openTasks} ticket${p.openTasks === 1 ? "" : "s"} to do${p.inProgress ? ` (${p.inProgress} in progress)` : ""}`}
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
                  {memText && (
                    <span
                      className={`shrink-0 font-mono text-[10px] tabular-nums ${(p.ports ?? []).length > 0 ? "" : "ml-auto"} ${over ? "font-semibold text-destructive" : "opacity-70"}`}
                      data-testid={`project-mem-${p.slug}`}
                    >
                      {memText}
                    </span>
                  )}
                  {p.openTasks > 0 && (
                    <span className={`shrink-0 tabular-nums opacity-70 ${(p.ports ?? []).length > 0 || memText ? "" : "ml-auto"}`}>
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
