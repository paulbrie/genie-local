import { TeamsView } from "@/components/teams/teams-view";
import { TEAMS_ROOT } from "@/lib/teams";

export const dynamic = "force-dynamic";

export default function TeamsPage() {
  return (
    <main className="mx-auto w-full max-w-7xl flex-1 space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Teams</h1>
        <p className="text-sm text-muted-foreground">
          Claude Code teams from recipes in <code className="font-mono">{TEAMS_ROOT}</code>: start a whole team (each member in its own
          admin-&lt;Name&gt; terminal), ask it to wrap up, and close its sessions.
        </p>
      </header>
      <TeamsView />
    </main>
  );
}
