"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  Bot,
  Container,
  Database,
  Globe,
  LayoutDashboard,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
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

import { ClaudeGlyph, claudeGlyphState } from "@/components/claude-glyph";
import { ThemeToggle } from "@/components/theme-toggle";
import { StatusDot } from "@/components/ui/status-dot";
import { BASE_PATH } from "@/lib/config";
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
};

const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/processes", label: "Processes", icon: Activity },
  { href: "/chrome", label: "Chrome", icon: Globe },
  { href: "/terminals", label: "Terminals", icon: SquareTerminal },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/docker", label: "Docker", icon: Container },
  { href: "/services", label: "Services", icon: Server },
  { href: "/railway", label: "Railway", icon: TrainFront },
  { href: "/db", label: "DB Explorer", icon: Database },
  { href: "/diagrams", label: "Diagrams", icon: Share2 },
  { href: "/logs", label: "Logs", icon: ScrollText },
  { href: "/claude", label: "Claude", icon: Sparkles },
];

const STORAGE_KEY = "admin.sidebar.collapsed";

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
          rail ? "md:w-16" : "md:w-60"
        } ${mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}`}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
          {!rail && (
            <Link
              href="/"
              onClick={closeMobile}
              className="flex-1 truncate text-sm font-semibold tracking-tight"
            >
              Supervisor
            </Link>
          )}
          {/* Collapse toggle — desktop only. */}
          <button
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand" : "Collapse"}
            className="ml-auto hidden text-muted-foreground transition-colors hover:text-foreground md:block"
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
                onClick={closeMobile}
                aria-current={active ? "page" : undefined}
                title={
                  rail
                    ? `${item.label}${badge ? ` (${badge})` : ""}`
                    : undefined
                }
                className={`relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                  rail ? "justify-center" : ""
                } ${
                  active
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                }`}
              >
                <Icon className="size-4 shrink-0" />
                {!rail && <span className="truncate">{item.label}</span>}
                {badge != null &&
                  (rail ? (
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
              {item.href === "/agents" && !rail && liveRuns.length > 0 && (
                <div className="mt-0.5 flex flex-col gap-0.5">
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
                        className="flex items-center gap-2 rounded-md py-1 pr-2 pl-8 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
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
                  <div className="mt-0.5 flex flex-col gap-0.5">
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
                        className="flex items-center gap-2 rounded-md py-1 pr-2 pl-8 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
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
      </nav>

        <div
          className={`flex shrink-0 items-center gap-1 border-t p-2 ${
            rail ? "flex-col" : ""
          }`}
        >
          <ThemeToggle />
          <button
            onClick={logout}
            title="Logout"
            className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground ${
              rail ? "justify-center" : "flex-1"
            }`}
          >
            <LogOut className="size-4 shrink-0" />
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
