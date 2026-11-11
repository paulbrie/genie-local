"use client";

import {
  ArrowRight,
  Code2,
  FolderKanban,
  LayoutGrid,
  Monitor,
  MoonStar,
  PanelLeft,
  Search,
  SquareTerminal,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { useSubject } from "subjecto/react";

import { useShellMode } from "@/components/desktop/shell-mode";
import { NAV_FLAT } from "@/components/nav-items";
import { SETTINGS_PANES } from "@/components/settings/panes";
import { rankCommands, isPaletteShortcut, type Command } from "@/lib/command-search";
import { BASE_PATH } from "@/lib/config";
import type { ProjectNavItem } from "@/lib/dashboard-metrics";
import { PROJECT_TAB_LABELS, PROJECT_TABS } from "@/lib/project-tabs";
import { cn } from "@/lib/utils";
import { Z_COMMAND_PALETTE } from "@/lib/z-layers";
import { launchpad, showWindow } from "@/store/desktop";
import { liveTerminals, openTerminal } from "@/store/terminals";
import { commandPalette } from "@/store/ui";

/** "⌘K" on a Mac, "Ctrl K" elsewhere (the server renders the latter; the client corrects it). */
function useShortcutLabel(): string {
  const mac = useSyncExternalStore(
    () => () => {},
    () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent),
    () => false,
  );
  return mac ? "⌘K" : "Ctrl K";
}

/** The top bar's way in, for the mouse: "Search  ⌘K". */
export function CommandPaletteButton() {
  const label = useShortcutLabel();
  return (
    <button
      type="button"
      onClick={() => commandPalette.next(true)}
      title={`Go to a page, project, tab or terminal (${label})`}
      className="flex h-7 shrink-0 items-center gap-2 rounded-md border bg-muted/40 px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Search className="size-3.5" />
      <span className="hidden lg:inline">Search</span>
      <kbd className="hidden rounded border bg-background px-1 font-mono text-[10px] sm:inline">{label}</kbd>
    </button>
  );
}

/**
 * ⌘K / Ctrl+K anywhere: a palette to go to any page, project, project tab or terminal, or run a few actions, by
 * typing (↑↓ to move, Enter to open, Esc to close). Code editors keep their own ⌘K / Ctrl+K chords, and a terminal
 * its Ctrl+K (delete to the end of the line); ⌘K still opens it from a terminal.
 */
export function CommandPalette() {
  const pathname = usePathname();
  const [open] = useSubject(commandPalette);

  useEffect(() => {
    if (pathname === "/login") return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      const where = { inEditor: !!t?.closest(".monaco-editor, .cm-editor"), inTerminal: !!t?.closest(".xterm") };
      if (!isPaletteShortcut(e, where)) return;
      e.preventDefault();
      e.stopPropagation();
      commandPalette.next(!commandPalette.getValue());
    };
    // (capture: before a page's own handlers, so none can swallow it)
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pathname]);

  return open && pathname !== "/login" ? <Palette /> : null;
}

type Item = Command & { icon: LucideIcon; run: () => void };

// (projects, once fetched, for a minute: the palette opens often)
let projectsCache: { at: number; list: ProjectNavItem[] } | null = null;

function Palette() {
  const router = useRouter();
  const { mode, setMode } = useShellMode();
  const { resolvedTheme, setTheme } = useTheme();
  const [terminals] = useSubject(liveTerminals);
  const [projects, setProjects] = useState<ProjectNavItem[]>(projectsCache?.list ?? []);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const close = () => commandPalette.next(false);

  useEffect(() => {
    if (projectsCache && Date.now() - projectsCache.at < 60_000) return;
    let live = true;
    fetch(`${BASE_PATH}/api/projects`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { projects?: ProjectNavItem[] } | null) => {
        if (!live || !json?.projects) return;
        projectsCache = { at: Date.now(), list: json.projects };
        setProjects(json.projects);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const items = useMemo<Item[]>(() => {
    const go = (href: string) => () => {
      close();
      router.push(href);
      showWindow(); // (the desktop: bring its window back if it was minimized or closed)
    };
    const desktop = mode === "desktop";
    const dark = resolvedTheme === "dark";
    const out: Item[] = NAV_FLAT.map((n) => ({
      id: `page:${n.href}`,
      kind: "page",
      label: n.label,
      keywords: n.href.slice(1).replace(/\//g, " "),
      icon: n.icon,
      run: go(n.href),
    }));
    // (the Settings app's panes but its first, which is the app itself: Users in Settings)
    for (const p of SETTINGS_PANES.slice(1))
      out.push({ id: `page:${p.href}`, kind: "page", label: p.label, detail: "Settings", keywords: `settings ${p.keywords}`, icon: p.icon, run: go(p.href) });
    for (const p of projects) {
      const base = `/projects/${encodeURIComponent(p.slug)}`;
      out.push({
        id: `project:${p.slug}`,
        kind: "project",
        label: p.slug,
        detail: [p.running ? "running" : null, p.openTasks ? `${p.openTasks} to do` : null].filter(Boolean).join(" · ") || undefined,
        keywords: "project",
        icon: FolderKanban,
        run: go(base),
      });
      for (const tab of PROJECT_TABS) {
        out.push({
          id: `tab:${p.slug}:${tab}`,
          kind: "tab",
          label: `${p.slug} › ${PROJECT_TAB_LABELS[tab]}`,
          keywords: `${p.slug} ${tab}`,
          icon: ArrowRight,
          run: go(`${base}/${tab}`),
        });
      }
    }
    for (const t of terminals) {
      out.push({
        id: `terminal:${t.name}`,
        kind: "terminal",
        label: t.name,
        detail: t.status.replace(/^claude-/, "Claude "),
        keywords: "terminal",
        icon: SquareTerminal,
        run: () => {
          close();
          openTerminal(t.name);
        },
      });
    }
    out.push(
      {
        id: "action:shell",
        kind: "action",
        label: desktop ? "Switch to the classic view" : "Switch to the desktop view",
        keywords: "interface shell sidebar desktop classic view",
        icon: desktop ? PanelLeft : Monitor,
        run: () => {
          close();
          setMode(desktop ? "classic" : "desktop");
        },
      },
      {
        id: "action:theme",
        kind: "action",
        label: dark ? "Switch to the light theme" : "Switch to the dark theme",
        keywords: "theme mode appearance light dark",
        icon: dark ? Sun : MoonStar,
        run: () => {
          close();
          setTheme(dark ? "light" : "dark");
        },
      },
      {
        id: "action:vscode",
        kind: "action",
        label: "Open VS Code",
        keywords: "editor code vscode",
        icon: Code2,
        run: () => {
          close();
          window.open("/vscode/", "_blank", "noopener");
        },
      },
    );
    if (desktop) {
      out.push({
        id: "action:launchpad",
        kind: "action",
        label: "Show every app (Launchpad)",
        keywords: "launchpad apps all",
        icon: LayoutGrid,
        run: () => {
          close();
          launchpad.next(true);
        },
      });
    }
    return out;
  }, [projects, terminals, mode, setMode, resolvedTheme, setTheme, router]);

  // (an empty query lists the pages and the actions; projects, tabs and terminals answer to typing)
  const results = useMemo(
    () => (q.trim() ? rankCommands(items, q) : items.filter((i) => i.kind === "page" || i.kind === "action")),
    [items, q],
  );
  const current = Math.min(sel, Math.max(0, results.length - 1));

  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setSel(results.length ? (current + 1) % results.length : 0);
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setSel(results.length ? (current - 1 + results.length) % results.length : 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      results[current]?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  const KIND_LABEL: Record<Command["kind"], string> = { page: "Page", project: "Project", tab: "Tab", terminal: "Terminal", action: "Action" };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Go to"
      style={{ zIndex: Z_COMMAND_PALETTE }}
      className="fixed inset-0 flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-[2px] motion-safe:animate-in motion-safe:fade-in-0"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl motion-safe:animate-in motion-safe:zoom-in-95">
        <label className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Go to a page, project, tab or terminal…"
            aria-label="Search"
            aria-controls="command-palette-results"
            aria-activedescendant={results[current] ? `cmd-${current}` : undefined}
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border px-1.5 font-mono text-[10px] text-muted-foreground">Esc</kbd>
        </label>
        <div ref={list} id="command-palette-results" role="listbox" className="overflow-y-auto p-1.5">
          {results.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches “{q}”.</p>}
          {results.map((r, i) => {
            const Icon = r.icon;
            return (
              <button
                key={r.id}
                id={`cmd-${i}`}
                data-index={i}
                type="button"
                role="option"
                aria-selected={i === current}
                onMouseMove={() => i !== current && setSel(i)}
                onClick={() => r.run()}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm",
                  i === current ? "bg-accent text-accent-foreground" : "text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{r.label}</span>
                {r.detail && <span className="shrink-0 truncate text-xs text-muted-foreground">{r.detail}</span>}
                <span className="w-14 shrink-0 text-right text-[10px] tracking-wide text-muted-foreground uppercase">{KIND_LABEL[r.kind]}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-3 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
          {!q.trim() && <span className="ml-auto">type to find projects, their tabs and terminals</span>}
        </div>
      </div>
    </div>
  );
}
