"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { House, LogOut, Moon, PanelLeft, PictureInPicture2, Settings, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSubject } from "subjecto/react";

import { Wisp } from "@/components/brand/wisp";
import { useShellMode } from "@/components/desktop/shell-mode";
import { WIDGET_ICON } from "@/components/desktop/widget-registry";
import { NAV_FLAT, NAV_HREFS } from "@/components/nav-items";
import { BASE_PATH } from "@/lib/config";
import { appOf, WIDGET_LABEL, widgetMode, WIDGETS } from "@/lib/desktop";
import { useWispState } from "@/lib/use-nav-badges";
import { desk, minimizeAll, openFrame, raiseApp, setWidgetMode } from "@/store/desktop";

/** Settings: its window to the front if it's popped out, else inline (`push`). */
export function openSettings(push: (href: string) => void) {
  if (!raiseApp("/settings")) push("/settings");
}

/**
 * The top bar's left end in the desktop interface, where a desktop OS keeps its
 * menu: the wisp (the agents' state, as on the sidebar) opening the Spiridus
 * menu (Settings, Home, show or hide the widgets, back to classic, theme, log
 * out), then the name of the page inline (Home at "/"), and beside it the icon
 * that pops that page out as a window (its pop-up's title bar puts it back).
 */
export function DesktopMenu() {
  const pathname = usePathname();
  const router = useRouter();
  const { setMode } = useShellMode();
  const { motion, title, wink } = useWispState();
  const { resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [{ widgets }] = useSubject(desk);
  const rootRef = useRef<HTMLDivElement>(null);
  const app = NAV_FLAT.find((i) => i.href === appOf(pathname, NAV_HREFS));
  const home = pathname === "/";
  // The page inline, popped out: a window of its own over the content area (where its app's last was), the area
  // going back to Home. (The page loads afresh in the window: it's a frame.)
  const detach = () => {
    openFrame(pathname + window.location.search, app?.href ?? null);
    router.push("/");
  };

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
    // (on a phone, the top bar's menu button opens the sidebar instead: that's the phone's way round)
    <div ref={rootRef} className="relative hidden shrink-0 items-center gap-2 md:flex">
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
      <span className="hidden max-w-40 truncate text-[13px] font-semibold sm:inline">{home ? "Home" : (app?.label ?? "Page")}</span>
      {/* (beside the page's name: never over a page's own controls, which sit at its top right) */}
      {!home && (
        <button
          type="button"
          onClick={detach}
          aria-label="Pop out as a window"
          title="Pop out as a window (its title bar puts it back)"
          className="-ml-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <PictureInPicture2 className="size-3.5" />
        </button>
      )}
      {open && (
        <div
          role="menu"
          className="absolute top-full left-0 mt-1.5 w-56 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
        >
          <button
            type="button"
            role="menuitem"
            onClick={pick(() => openSettings((href) => router.push(href)))}
            className={row}
          >
            <Settings /> Settings…
          </button>
          <div className="-mx-1 my-1 h-px bg-border" />
          <button
            type="button"
            role="menuitem"
            onClick={pick(() => {
              minimizeAll();
              router.push("/");
            })}
            className={row}
          >
            <House /> Show Home
          </button>
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
