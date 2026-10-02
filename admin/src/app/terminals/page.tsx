import { TerminalsPanel } from "@/components/terminals-panel";

export const dynamic = "force-dynamic";

export default function TerminalsPage() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Terminals</h1>
        <p className="text-sm text-muted-foreground">
          Detached tmux sessions that keep running after you close the tab.
          Reconnect any time — the terminal is still where you left it.
        </p>
      </header>
      <TerminalsPanel />
    </main>
  );
}
