import { cookies } from "next/headers";

import { AutoRefresh } from "@/components/auto-refresh";
import { DashboardOverview } from "@/components/dashboard-overview";
import { ProjectDiskUsage } from "@/components/project-disk-usage";
import { getDashboardMetrics } from "@/lib/dashboard-metrics";
import { parseShellMode, SHELL_COOKIE } from "@/lib/desktop";

// Live numbers from every area: never statically cached.
export const dynamic = "force-dynamic";

/**
 * The Dashboard: headline metrics from every area of the app. In the desktop interface the home is the desktop itself
 * (components/desktop), so there's nothing to measure (switching to classic here refreshes it: app-shell.tsx).
 */
export default async function Home() {
  if (parseShellMode((await cookies()).get(SHELL_COOKIE)?.value) === "desktop") return null;
  const metrics = await getDashboardMetrics();
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Every area at a glance · refreshes every 15 s
        </p>
      </header>
      <DashboardOverview m={metrics} />
      <ProjectDiskUsage />
      <AutoRefresh ms={15_000} />
    </main>
  );
}
