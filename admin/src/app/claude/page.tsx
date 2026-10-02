import { ClaudeExplorer } from "@/components/claude/claude-explorer";
import { CLAUDE_HOME } from "@/lib/claude";

export const dynamic = "force-dynamic";

export default function ClaudePage() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Claude</h1>
        <p className="text-sm text-muted-foreground">
          Sessions, logs, and memories from{" "}
          <code className="font-mono">{CLAUDE_HOME}</code>.
        </p>
      </header>
      <ClaudeExplorer />
    </main>
  );
}
