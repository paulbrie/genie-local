"use client";

import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { Workspace } from "@/components/desktop/desktop";
import { rememberShellMode, ShellModeContext } from "@/components/desktop/shell-mode";
import { StatsToolbar } from "@/components/stats-toolbar";
import type { ShellMode } from "@/lib/desktop";

/**
 * The app's frame around every page: the top bar, and either the classic
 * sidebar beside the page or the desktop around it (the top bar's switch picks;
 * the layout passes what the cookie says). The login page has neither.
 */
export function AppShell({ initialMode, children }: { initialMode: ShellMode; children: React.ReactNode }) {
  const pathname = usePathname();
  const [mode, setMode] = useState(initialMode);
  const ctx = useMemo(
    () => ({
      mode,
      setMode: (m: ShellMode) => {
        rememberShellMode(m);
        setMode(m);
      },
    }),
    [mode],
  );
  const desktop = mode === "desktop" && pathname !== "/login";
  return (
    <ShellModeContext value={ctx}>
      <div className="flex h-screen overflow-hidden">
        {desktop ? null : <AppSidebar />}
        <div className="flex min-w-0 flex-1 flex-col">
          <StatsToolbar />
          <Workspace desktop={desktop}>{children}</Workspace>
        </div>
      </div>
    </ShellModeContext>
  );
}
