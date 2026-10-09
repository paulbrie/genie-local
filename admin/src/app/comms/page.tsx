import { CommsView } from "@/components/comms/comms-view";

export const dynamic = "force-dynamic";

export default function CommsPage() {
  return (
    <main className="mx-auto flex w-full max-w-[96rem] flex-1 flex-col space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Comms</h1>
        <p className="text-sm text-muted-foreground">
          Messages between Claude Code sessions (SendMessage), with the tasks,
          file claims and commits read from them. Tagged messages (
          <code className="font-mono">TASK:</code>,{" "}
          <code className="font-mono">CLAIM:</code>,{" "}
          <code className="font-mono">COMMIT:</code>…) are read exactly; the
          rest are guessed from wording and marked as guesses. Credentials are
          redacted.
        </p>
      </header>
      <CommsView />
    </main>
  );
}
