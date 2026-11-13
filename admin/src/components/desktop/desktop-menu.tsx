"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { House, LogOut, Moon, PictureInPicture2, Settings, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSubject } from "subjecto/react";

import { Lockup, Wisp } from "@/components/brand/wisp";
import { NAV_FLAT, NAV_HREFS } from "@/components/nav-items";
import { BASE_PATH } from "@/lib/config";
import { appOf } from "@/lib/desktop";
import { useWispState } from "@/lib/use-nav-badges";
import { detachLive, liveWin, minimizeAll, openPage } from "@/store/desktop";

/** Settings: its window to the front if it's popped out, else inline (`push`). */
export function openSettings(push: (href: string) => void) {
  openPage("/settings", push);
}

/**
 * The Spiridus menu, from the sidebar's logo (the lockup, the wisp alone on the rail; the wisp shows the agents' state,
 * winks on hover): Settings, Home, the theme, log out, as a dropdown under it (the widgets are shown or hidden from the
 * wallpaper's right-click and Settings). `onPick`: after an item is picked (the phone's drawer closes).
 */
export function SpiridusMenu({ rail, onPick }: { rail: boolean; onPick?: () => void }) {
  const router = useRouter();
  const { motion, title, wink } = useWispState();
  const { resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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
    onPick?.();
    fn();
  };
  const dark = resolvedTheme === "dark";
  const row =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

  return (
    <div ref={rootRef} className={`relative flex min-w-0 items-center ${rail ? "" : "flex-1"}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={wink}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Spiridus menu"
        title={title}
        className={`flex items-center rounded-md transition-colors hover:bg-accent/60 ${rail ? "p-0.5" : "-ml-1 px-1 py-0.5"} ${open ? "bg-accent/60" : ""}`}
      >
        {rail ? <Wisp size={22} motion={motion} title="" /> : <Lockup size={20} motion={motion} />}
      </button>
      {open && (
        <div
          role="menu"
          className="scrollbar-hover absolute top-full left-0 z-50 mt-1.5 max-h-[calc(100vh-3.5rem)] w-56 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
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
              openPage("/", (href) => router.push(href));
            })}
            className={row}
          >
            <House /> Show Home
          </button>
          <div className="-mx-1 my-1 h-px bg-border" />
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

/**
 * The top bar's left, before the rings: the name of the page inline (Home at "/", or while the page floats over it,
 * live), and beside it the icon that pops the page out as a window, live (its title bar puts it back): beside the
 * page's name, it's never over a page's own controls, which sit at its top right. Not on a phone (no pop-ups there).
 */
export function PageTitle() {
  const pathname = usePathname();
  const [live] = useSubject(liveWin);
  const app = NAV_FLAT.find((i) => i.href === appOf(pathname, NAV_HREFS));
  // what's inline: Home, at "/" or while the page floats over it, live
  const home = pathname === "/" || (!!live && live.path.split("?")[0] === pathname);
  // The page inline, popped out live: a window of its own over the content area, as it is (nothing reloads), Home
  // behind it, the URL its own.
  const detach = () => detachLive(pathname + window.location.search, app?.href ?? null);
  return (
    <div className="hidden shrink-0 items-center gap-1 md:flex">
      <span className="max-w-40 truncate text-[13px] font-semibold">{home ? "Home" : (app?.label ?? "Page")}</span>
      {!home && (
        <button
          type="button"
          onClick={detach}
          aria-label="Pop out as a window"
          title="Pop out as a window (its title bar puts it back)"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <PictureInPicture2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}
