import { AutoRefresh } from "@/components/auto-refresh";
import { DashboardOverview } from "@/components/dashboard-overview";
import { getDashboardMetrics } from "@/lib/dashboard-metrics";

// Live numbers from every area: never statically cached.
export const dynamic = "force-dynamic";

/** The Dashboard: headline metrics from every area of the app. */
export default async function Home() {
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
      <AutoRefresh ms={15_000} />
    </main>
  );
}
