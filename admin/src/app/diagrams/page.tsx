import { DiagramManager } from "@/components/diagrams/diagram-manager";
import { listArchivedDiagrams, listDiagrams } from "@/lib/diagrams";

export const dynamic = "force-dynamic";

export default async function DiagramsPage() {
  const [diagrams, archived] = await Promise.all([
    listDiagrams(),
    listArchivedDiagrams(),
  ]);
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Diagrams</h1>
        <p className="text-sm text-muted-foreground">
          Author diagrams in{" "}
          <a
            href="https://mermaid.js.org/intro/"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            Mermaid
          </a>{" "}
          — plain text an agent can write for you. Edits render live.
        </p>
      </header>
      <DiagramManager initial={diagrams} initialArchived={archived} />
    </main>
  );
}
