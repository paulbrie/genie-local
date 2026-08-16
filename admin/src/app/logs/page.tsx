import { LogsViewer } from "@/components/logs/logs-viewer";
import { LOGS_ROOT } from "@/lib/logs";

export const dynamic = "force-dynamic";

export default function LogsPage() {
  return (
    <main className="mx-auto w-full max-w-7xl flex-1 space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Logs</h1>
        <p className="text-sm text-muted-foreground">
          Inspect log files under{" "}
          <code className="font-mono">{LOGS_ROOT}</code>. Auto-tails the selected
          file.
        </p>
      </header>
      <LogsViewer />
    </main>
  );
}
