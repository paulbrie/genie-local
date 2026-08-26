import { Dashboard } from "@/components/dashboard";
import { getRunningInfo } from "@/lib/app-run-status";
import { PROJECTS_ROOT } from "@/lib/signals";
import { scanAndPersist } from "@/lib/scan";

// The dashboard reads live git/fs signals and writes a snapshot on every load,
// so it must never be statically cached.
export const dynamic = "force-dynamic";

export default async function Home() {
  const [projects, runs] = await Promise.all([
    scanAndPersist(),
    getRunningInfo(),
  ]);
  const running = runs.map((r) => r.slug);
  const initialMemory = Object.fromEntries(
    runs.map((r) => [r.slug, r.rssBytes]),
  );

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Projects Supervisor
        </h1>
        <p className="text-sm text-muted-foreground">
          Live status of every project under{" "}
          <code className="font-mono">{PROJECTS_ROOT}</code>
        </p>
      </header>

      <Dashboard
        projects={projects}
        initialRunning={running}
        initialMemory={initialMemory}
      />
    </main>
  );
}
