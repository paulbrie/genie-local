import { Agents3DView } from "@/components/agents3d/agents3d-view";

export const dynamic = "force-dynamic";

export default function Agents3DPage() {
  return (
    <main className="mx-auto flex w-full max-w-[110rem] flex-1 flex-col space-y-3 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Agents City</h1>
        <p className="text-sm text-muted-foreground">
          The Claude Code sessions at work: who is busy, on which file and task, the messages between them, file
          claims, edits and commits. Live, or replayed with the scrubber.
        </p>
      </header>
      <Agents3DView />
    </main>
  );
}
