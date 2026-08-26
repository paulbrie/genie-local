import { RailwayExplorer } from "@/components/railway-explorer";

export const dynamic = "force-dynamic";

export default function RailwayPage() {
  return (
    <main className="mx-auto flex h-full w-full max-w-7xl flex-1 flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Railway</h1>
        <p className="text-sm text-muted-foreground">
          Every project in the connected Railway workspace. Pick a service, tail
          and filter its deployment logs, then hand them to an agent for
          discovery.
        </p>
      </header>
      <RailwayExplorer />
    </main>
  );
}
