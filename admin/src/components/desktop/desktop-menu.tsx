"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowDownAZ, LayoutGrid, LogOut, Monitor, Moon, PanelLeft, RotateCcw, Settings, Sun, Undo2 } from "lucide-react";
import { useTheme } from "next-themes";
import { useSubject } from "subjecto/react";

import { Wisp } from "@/components/brand/wisp";
import { useShellMode } from "@/components/desktop/shell-mode";
import { WIDGET_ICON } from "@/components/desktop/widget-registry";
import { NAV_FLAT, NAV_HREFS } from "@/components/nav-items";
import { BASE_PATH } from "@/lib/config";
import { appOf, type CellRect, deskWidgets, dockSpace, iconGridSize, sortedIcons, VSCODE_ICON, WIDGET_LABEL, widgetMode, WIDGETS } from "@/lib/desktop";
import { useWispState } from "@/lib/use-nav-badges";
import { desk, deskView, launchpad, minimizeWindow, openAppWindow, restoreIcons, setIcons, setWidgetMode, showWindow } from "@/store/desktop";

/** The icons in alphabetical order, flowing around the widgets (the desktop: the window under the 40px top bar, the dock at its size). */
export function sortIconsByName() {
  const { widgets, removedIcons, dockSize } = desk.getValue();
  const { cols, rows } = iconGridSize(window.innerWidth, window.innerHeight - 40, dockSpace(dockSize));
  const around = Object.values(deskWidgets(widgets, cols, rows)).filter((r): r is CellRect => !!r);
  const labels = new Map<string, string>([...NAV_FLAT.map((i) => [i.href, i.label] as const), [VSCODE_ICON, "VS Code"]]);
  const shown = [...labels.keys()].filter((id) => !removedIcons?.includes(id));
  setIcons(sortedIcons(shown, (id) => labels.get(id) ?? id, rows, around));
}

/** Settings: its window to the front, or a new one (the page's own window, through `push`, when that's closed). */
export function openSettings(pathname: string, push: (href: string) => void) {
  if (openAppWindow("/settings", "/settings", appOf(pathname, NAV_HREFS))) return;
  showWindow();
  push("/settings");
}

/**
 * The top bar's left end in the desktop interface, where a desktop OS keeps its
 * menu: the wisp (the agents' state, as on the sidebar) opening the Spiridus
 * menu (Settings, show the desktop, Launchpad, sort, reset or put back the icons, show or hide the widgets, back to classic, theme, log
 * out), then
 * the name of the app in the window.
 */
export function DesktopMenu() {
  const pathname = usePathname();
  const router = useRouter();
  const { setMode } = useShellMode();
  const { motion, title, wink } = useWispState();
  const { resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [{ widgets, removedIcons }] = useSubject(desk);
  const rootRef = useRef<HTMLDivElement>(null);
  const app = NAV_FLAT.find((i) => i.href === appOf(pathname, NAV_HREFS));

  // Dismiss on a click outside, or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const dark = resolvedTheme === "dark";
  const row =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

  return (
    <div ref={rootRef} className="relative flex shrink-0 items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={wink}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Spiridus menu"
        title={title}
        className={`-ml-1.5 flex items-center rounded-md p-1 transition-colors hover:bg-accent/60 ${open ? "bg-accent/60" : ""}`}
      >
        <Wisp size={20} motion={motion} title="" />
      </button>
      <span className="hidden max-w-40 truncate text-[13px] font-semibold sm:inline">{app?.label ?? "Desktop"}</span>
      {open && (
        <div
          role="menu"
          className="absolute top-full left-0 mt-1.5 w-56 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
        >
          <button
            type="button"
            role="menuitem"
            onClick={pick(() => openSettings(pathname, (href) => router.push(href)))}
            className={row}
          >
            <Settings /> Settings…
          </button>
          <div className="-mx-1 my-1 h-px bg-border" />
          <button
            type="button"
            role="menuitem"
            onClick={pick(() => deskView.getValue().hidden || minimizeWindow())}
            className={row}
          >
            <Monitor /> Show desktop
          </button>
          <button type="button" role="menuitem" onClick={pick(() => launchpad.next(true))} className={row}>
            <LayoutGrid /> Launchpad
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={pick(sortIconsByName)}
            className={row}
          >
            <ArrowDownAZ /> Sort icons by name
          </button>
          <button type="button" role="menuitem" onClick={pick(() => setIcons(null))} className={row}>
            <RotateCcw /> Reset icon order
          </button>
          {!!removedIcons?.length && (
            <button type="button" role="menuitem" onClick={pick(restoreIcons)} className={row}>
              <Undo2 /> Put back removed icons ({removedIcons.length})
            </button>
          )}
          {WIDGETS.map((id) => {
            const hidden = widgetMode(widgets, id) === "hidden";
            const Icon = WIDGET_ICON[id];
            return (
              <button key={id} type="button" role="menuitem" onClick={pick(() => setWidgetMode(id, hidden ? "open" : "hidden"))} className={row}>
                <Icon /> {hidden ? "Show" : "Hide"} the {WIDGET_LABEL[id].toLowerCase()} widget
              </button>
            );
          })}
          <div className="-mx-1 my-1 h-px bg-border" />
          <button type="button" role="menuitem" onClick={pick(() => setMode("classic"))} className={row}>
            <PanelLeft /> Classic view
          </button>
          <button type="button" role="menuitem" onClick={pick(() => setTheme(dark ? "light" : "dark"))} className={row}>
            {dark ? <Sun /> : <Moon />} {dark ? "Light mode" : "Dark mode"}
          </button>
          <div className="-mx-1 my-1 h-px bg-border" />
          <button
            type="button"
            role="menuitem"
            onClick={pick(async () => {
              await fetch(`${BASE_PATH}/api/logout`, { method: "POST" }).catch(() => {});
              window.location.assign(`${BASE_PATH}/login`);
            })}
            className={row}
          >
            <LogOut /> Log out
          </button>
        </div>
      )}
    </div>
  );
}
