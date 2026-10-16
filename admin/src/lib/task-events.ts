import "server-only";

import { EventEmitter } from "node:events";

import { Client } from "pg";

/**
 * Live task changes. One dedicated connection LISTENs on `task_changes` (sent
 * by the triggers of migration 0011 for tasks, comments and files, whoever
 * writes them) and fans each event out to the SSE streams of open boards.
 */
export type TaskChange = {
  projectId: number;
  taskId: number;
  table: "tasks" | "task_comments" | "task_attachments";
  op: "INSERT" | "UPDATE" | "DELETE";
};

const CHANNEL = "task_changes";
const RECONNECT_MS = 3000;

type Hub = { emitter: EventEmitter; client: Client | null; starting: boolean };

// One hub per process, kept across dev hot-reloads.
const g = globalThis as unknown as { __taskEvents?: Hub };
const hub: Hub = (g.__taskEvents ??= {
  emitter: new EventEmitter().setMaxListeners(0),
  client: null,
  starting: false,
});

async function connect() {
  if (hub.client || hub.starting) return;
  hub.starting = true;
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  let retried = false;
  const retry = () => {
    // `error` and `end` can both fire for one failure: reconnect once.
    if (retried) return;
    retried = true;
    if (hub.client === client) hub.client = null;
    client.end().catch(() => {});
    // Streams stay open; tell them to resync once we're back.
    setTimeout(() => {
      if (hub.emitter.listenerCount("change") > 0) {
        connect().then(() => hub.emitter.emit("resync"));
      }
    }, RECONNECT_MS);
  };
  try {
    client.on("notification", (n) => {
      if (n.channel !== CHANNEL || !n.payload) return;
      try {
        hub.emitter.emit("change", JSON.parse(n.payload) as TaskChange);
      } catch {
        /* malformed payload: ignore */
      }
    });
    client.on("error", retry);
    client.on("end", retry);
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    hub.client = client;
  } catch (err) {
    console.error("[task-events] listen failed:", err instanceof Error ? err.message : err);
    retry();
  } finally {
    hub.starting = false;
  }
}

/**
 * Call `onChange` for every change to the project's tasks, and `onResync`
 * after a lost DB connection comes back (events may have been missed).
 * Returns the unsubscribe function.
 */
export function subscribeTaskChanges(
  projectId: number,
  onChange: (c: TaskChange) => void,
  onResync: () => void,
): () => void {
  const listener = (c: TaskChange) => {
    if (c.projectId === projectId) onChange(c);
  };
  hub.emitter.on("change", listener);
  hub.emitter.on("resync", onResync);
  void connect();
  return () => {
    hub.emitter.off("change", listener);
    hub.emitter.off("resync", onResync);
  };
}
