"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  Bot,
  Database,
  Globe,
  LayoutDashboard,
  LogOut,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  SquareTerminal,
  Workflow,
} from "lucide-react";
import { useSubject } from "subjecto/react";

import { ThemeToggle } from "@/components/theme-toggle";
import { BASE_PATH } from "@/lib/config";
import { activeRuns, openRun } from "@/store/runs";
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
};

const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/processes", label: "Processes", icon: Activity },
  { href: "/chrome", label: "Chrome", icon: Globe },
  { href: "/terminals", label: "Terminals", icon: SquareTerminal },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/db", label: "DB Explorer", icon: Database },
  { href: "/logs", label: "Logs", icon: ScrollText },
  { href: "/task-browser", label: "Task browser", icon: Monitor },
];

const STORAGE_KEY = "admin.sidebar.collapsed";

/**
 * Collapsible left navigation rail. Holds every top-level route plus the global
 * theme + logout controls. Collapsed/expanded state persists in localStorage.
 */
export function AppSidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [chromeCount, setChromeCount] = useState<number | null>(null);
  const [runs] = useSubject(activeRuns);
  // Currently-active runs (kept fresh by <RunDock>), shown as sub-items.
  const liveRuns = runs.filter(
    (r) => r.running || r.state === "running" || r.state === "starting",
  );
  const [terms] = useSubject(liveTerminals);
  // "Currently working" = anything not sitting idle at a shell prompt.
  const workingTerms = terms.filter((t) => t.status !== "idle");

  // Restore persisted state after mount (avoids SSR/client mismatch).
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      /* private mode / no storage — keep default */
    }
  }, []);

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
    <aside
      className={`${
        collapsed ? "w-16" : "w-60"
      } flex h-screen shrink-0 flex-col border-r bg-background/95 transition-[width] duration-200`}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        {!collapsed && (
          <Link
            href="/"
            className="flex-1 truncate text-sm font-semibold tracking-tight"
          >
            Supervisor
          </Link>
        )}
        <button
          onClick={toggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand" : "Collapse"}
          className="ml-auto text-muted-foreground transition-colors hover:text-foreground"
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" />
          ) : (
            <PanelLeftClose className="size-4" />
          )}
        </button>
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
        {NAV.map((item) => {
          const active = item.exact
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          const badge =
            item.href === "/chrome" && chromeCount
              ? chromeCount
              : item.href === "/agents" && liveRuns.length
                ? liveRuns.length
                : item.href === "/terminals" && workingTerms.length
                  ? workingTerms.length
                  : null;
          return (
            <div key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                title={
                  collapsed
                    ? `${item.label}${badge ? ` (${badge})` : ""}`
                    : undefined
                }
                className={`relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                  collapsed ? "justify-center" : ""
                } ${
                  active
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                }`}
              >
                <Icon className="size-4 shrink-0" />
                {!collapsed && <span className="truncate">{item.label}</span>}
                {badge != null &&
                  (collapsed ? (
                    <span className="absolute -top-0.5 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
                      {badge}
                    </span>
                  ) : (
                    <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-xs font-medium text-primary">
                      {badge}
                    </span>
                  ))}
              </Link>

              {/* Live agent/pipeline runs, as sub-items under Agents. Clicking
                  opens (or un-minimizes) the run's window in the global dock. */}
              {item.href === "/agents" && !collapsed && liveRuns.length > 0 && (
                <div className="mt-0.5 flex flex-col gap-0.5">
                  {liveRuns.map((r) => {
                    const KindIcon = r.kind === "pipeline" ? Workflow : Bot;
                    return (
                      <button
                        key={r.runId}
                        type="button"
                        onClick={() => openRun(r.runId)}
                        title={`Open ${r.name}${
                          r.kind === "pipeline"
                            ? ` — ${r.stepsDone}/${r.stepsTotal}`
                            : ""
                        }`}
                        className="flex items-center gap-2 rounded-md py-1 pr-2 pl-8 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                      >
                        <span className="relative flex size-1.5 shrink-0 items-center justify-center">
                          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400/70" />
                          <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
                        </span>
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
                !collapsed &&
                workingTerms.length > 0 && (
                  <div className="mt-0.5 flex flex-col gap-0.5">
                    {workingTerms.map((t) => (
                      <button
                        key={t.name}
                        type="button"
                        onClick={() => openTerminal(t.name)}
                        title={`Open ${t.name} — ${termLabel(t.status)}`}
                        className="flex items-center gap-2 rounded-md py-1 pr-2 pl-8 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                      >
                        <TermDot status={t.status} />
                        <span className="truncate">{t.name}</span>
                      </button>
                    ))}
                  </div>
                )}
            </div>
          );
        })}
      </nav>

      <div
        className={`flex shrink-0 items-center gap-1 border-t p-2 ${
          collapsed ? "flex-col" : ""
        }`}
      >
        <ThemeToggle />
        <button
          onClick={logout}
          title="Logout"
          className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground ${
            collapsed ? "justify-center" : "flex-1"
          }`}
        >
          <LogOut className="size-4 shrink-0" />
          {!collapsed && <span>Logout</span>}
        </button>
      </div>
    </aside>
  );
}

// Terminal status → dot colour + optional pulse. Mirrors the dock's palette:
// green = running a command, orange = a Claude session (pulsing while it works,
// steady while it waits).
const TERM_DOT: Record<TermStatus, { dot: string; ping: string | null }> = {
  idle: { dot: "bg-muted-foreground/40", ping: null },
  busy: { dot: "bg-emerald-500", ping: "bg-emerald-400" },
  "claude-working": { dot: "bg-orange-500", ping: "bg-orange-400" },
  "claude-waiting": { dot: "bg-orange-500", ping: null },
};

function termLabel(status: TermStatus): string {
  switch (status) {
    case "claude-working":
      return "Claude is working";
    case "claude-waiting":
      return "Claude is waiting for input";
    case "busy":
      return "Running a command";
    default:
      return "Idle";
  }
}

function TermDot({ status }: { status: TermStatus }) {
  const { dot, ping } = TERM_DOT[status];
  return (
    <span className="relative flex size-1.5 shrink-0 items-center justify-center">
      {ping && (
        <span
          className={`absolute inline-flex size-full animate-ping rounded-full opacity-70 ${ping}`}
        />
      )}
      <span className={`relative inline-flex size-1.5 rounded-full ${dot}`} />
    </span>
  );
}
