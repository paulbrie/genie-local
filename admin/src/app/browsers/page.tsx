import { BrowsersPanel } from "@/components/browsers/browsers-panel";

export const dynamic = "force-dynamic";

export default function BrowsersPage() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Browsers</h1>
        <p className="text-sm text-muted-foreground">
          Your own Chrome, driven from here through the Spiridus Bridge extension: pair a browser, share tabs from the
          extension&apos;s popup, then see them live, click and type in them, run JavaScript, or let an agent do it
          through <span className="font-mono">/api/browsers</span> (or <span className="font-mono">scripts/browsers-mcp.mjs</span>).
        </p>
      </header>
      <BrowsersPanel />
    </main>
  );
}
