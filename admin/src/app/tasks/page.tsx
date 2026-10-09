import { TasksBoard } from "@/components/tasks/tasks-board";

export const dynamic = "force-dynamic";

export default function TasksPage() {
  return (
    <main className="flex min-h-0 w-full flex-1 flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <p className="text-sm text-muted-foreground">
          The team&apos;s tasks, live from the comms (TASK / ACK / STATUS / BLOCKED / DONE / CANCELLED), as Comms and
          Agents City read them. Click a card for its thread, commits and claims.
        </p>
      </header>
      <TasksBoard />
    </main>
  );
}
