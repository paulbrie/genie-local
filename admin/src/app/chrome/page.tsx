import { ChromeInstances } from "@/components/chrome-instances";
import { ChromeViewer } from "@/components/chrome-viewer";

export const dynamic = "force-dynamic";

export default function ChromePage() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Chrome</h1>
        <p className="text-sm text-muted-foreground">
          Headless Chrome instances (mostly from agent-browser sessions) grouped
          by user-data-dir. See what an instance is looking at, or kill idle ones
          to reclaim memory.
        </p>
      </header>
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Live view</h2>
        <ChromeViewer />
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Instances</h2>
        <ChromeInstances />
      </section>
    </main>
  );
}
