"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { CommandPalette } from "@/components/command-palette";
import { Workspace } from "@/components/desktop/desktop";
import { rememberShellMode, ShellModeContext } from "@/components/desktop/shell-mode";
import { StatsToolbar } from "@/components/stats-toolbar";
import { isPaletteShortcut } from "@/lib/command-search";
import type { ShellMode } from "@/lib/desktop";
import { useScrollActivity } from "@/lib/use-scroll-activity";
import { openTerminalsIn } from "@/store/terminals";

/**
 * The app's frame around every page: the top bar, the sidebar, and the page
 * beside it (classic) or the desktop with the page in a window (the top bar's
 * switch picks; the layout passes what the cookie says). In the desktop the top
 * bar runs the whole width, the sidebar under it: a grid, its inner column
 * `display: contents`, so the page keeps its place in the tree either way. The
 * login page has none of it.
 */
export function AppShell({
  initialMode,
  embedded = false,
  children,
}: {
  initialMode: ShellMode;
  /** in one of the desktop's windows (a frame): the page alone */
  embedded?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [mode, setMode] = useState(initialMode);
  // (scrollbars show while hovered or scrolling: globals.css)
  useScrollActivity();
  const ctx = useMemo(
    () => ({
      mode,
      setMode: (m: ShellMode) => {
        rememberShellMode(m);
        setMode(m);
        // (the home's page is the Dashboard in classic only: the desktop's home had nothing to render)
        if (m === "classic" && pathname === "/") router.refresh();
      },
    }),
    [mode, pathname, router],
  );
  const desktop = mode === "desktop" && pathname !== "/login";
  if (embedded) {
    return (
      <ShellModeContext value={ctx}>
        <FramedPage>{children}</FramedPage>
      </ShellModeContext>
    );
  }
  return (
    <ShellModeContext value={ctx}>
      <div
        className={
          desktop
            ? "grid h-screen grid-cols-[auto_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden [&>aside]:col-start-1 [&>aside]:row-start-2"
            : "flex h-screen overflow-hidden"
        }
      >
        <AppSidebar />
        <div
          className={
            desktop
              ? "contents [&>div]:col-start-2 [&>div]:row-start-2 [&>header]:col-span-2 [&>header]:row-start-1"
              : "flex min-w-0 flex-1 flex-col"
          }
        >
          <StatsToolbar />
          <Workspace desktop={desktop}>{children}</Workspace>
        </div>
      </div>
      <CommandPalette />
    </ShellModeContext>
  );
}

/**
 * A page in one of the desktop's windows (FrameWindows in desktop.tsx): it fills the frame, and tells the window
 * where it is (its title bar), that it was clicked (to come to the front), ⌘K / Ctrl+K (the palette is the
 * page around it's), and the terminals it opens (they float over the whole desktop, from the page around it).
 */
function FramedPage({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  useEffect(() => {
    if (window.parent === window) return;
    window.parent.postMessage({ type: "spiridus:path", path: pathname + window.location.search, title: document.title }, window.location.origin);
  }, [pathname]);
  useEffect(() => {
    if (window.parent === window) return;
    const tell = (type: string, more: Record<string, unknown> = {}) => window.parent.postMessage({ type, ...more }, window.location.origin);
    openTerminalsIn((name) => tell("spiridus:terminal", { name }));
    const onDown = () => tell("spiridus:focus");
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!isPaletteShortcut(e, { inEditor: !!t?.closest(".monaco-editor, .cm-editor"), inTerminal: !!t?.closest(".xterm") })) return;
      e.preventDefault();
      tell("spiridus:palette");
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      openTerminalsIn(null);
    };
  }, []);
  return <div className="scrollbar-clear h-screen overflow-y-auto">{children}</div>;
}
