"use client";

import { Monitor, PanelLeft } from "lucide-react";
import { createContext, useContext } from "react";

import { BASE_PATH } from "@/lib/config";
import { SHELL_COOKIE, type ShellMode } from "@/lib/desktop";

/**
 * Which interface this browser uses: the classic sidebar, or the desktop. The
 * root layout reads it from a cookie, so the first paint is already the right
 * one; switching sets the cookie and swaps the shell in place (the page isn't
 * reloaded or remounted).
 */
export const ShellModeContext = createContext<{ mode: ShellMode; setMode: (m: ShellMode) => void }>({
  mode: "classic",
  setMode: () => {},
});

export const useShellMode = () => useContext(ShellModeContext);

/** Remember the interface for a year, for this mount only (/admin and /admin-dev each keep their own). */
export function rememberShellMode(mode: ShellMode) {
  document.cookie = `${SHELL_COOKIE}=${mode}; path=${BASE_PATH || "/"}; max-age=31536000; samesite=lax`;
}

/** The top bar's Classic / Desktop switch: a small segmented control. */
export function ShellSwitch() {
  const { mode, setMode } = useShellMode();
  const desktop = mode === "desktop";
  const seg = (on: boolean) =>
    `relative z-10 flex size-6 items-center justify-center rounded-[5px] transition-colors ${
      on ? "text-foreground" : "text-muted-foreground hover:text-foreground"
    }`;
  return (
    <div
      role="radiogroup"
      aria-label="Interface"
      className="relative flex shrink-0 items-center rounded-md bg-muted p-0.5 ring-1 ring-foreground/5"
    >
      {/* the thumb, sliding under the chosen side */}
      <span
        aria-hidden
        className={`absolute top-0.5 left-0.5 size-6 rounded-[5px] bg-background shadow-sm ring-1 ring-foreground/10 transition-transform duration-200 ${
          desktop ? "translate-x-6" : ""
        }`}
      />
      <button
        type="button"
        role="radio"
        aria-checked={!desktop}
        aria-label="Classic view"
        title="Classic view: the sidebar"
        onClick={() => setMode("classic")}
        className={seg(!desktop)}
      >
        <PanelLeft className="size-3.5" />
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={desktop}
        aria-label="Desktop view"
        title="Desktop view: widgets and windows"
        onClick={() => setMode("desktop")}
        className={seg(desktop)}
      >
        <Monitor className="size-3.5" />
      </button>
    </div>
  );
}
