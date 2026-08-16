import { Monitor } from "lucide-react";

import { TaskBrowserView } from "@/components/task-browser-view";

export const dynamic = "force-dynamic";

/**
 * Demo/harness page for the per-task live browser view. In real use, drop
 * <TaskBrowserView taskId={task.id} /> into a task's detail panel instead.
 */
export default function TaskBrowserPage() {
  // Stand-in task id for the prototype; each id → its own isolated browser.
  const taskId = "demo";

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 space-y-6 p-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Monitor className="size-6 text-muted-foreground" />
          Task browser
        </h1>
        <p className="text-sm text-muted-foreground">
          Live view of task{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{taskId}</code>
          &rsquo;s isolated browser (agent-browser session{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            task-{taskId}
          </code>
          ), streamed as MJPEG through this origin. Toggle the pointer button to
          forward clicks into the live browser.
        </p>
      </header>

      <TaskBrowserView taskId={taskId} />
    </main>
  );
}
