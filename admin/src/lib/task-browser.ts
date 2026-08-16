import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import WebSocket from "ws";

/**
 * Server-only bridge to the globally-installed `agent-browser` CLI.
 *
 * Each admin task drives its own isolated browser via a named agent-browser
 * *session* (`--session task-<id>`). The CLI talks to a persistent daemon, so
 * every command here is cheap and reuses the same live Chrome for a task.
 *
 * The per-session live viewport is exposed by agent-browser as a localhost-only
 * WebSocket emitting `{type:"frame", data:<base64 jpeg>}` messages. It is NOT
 * reachable from the browser (localhost, ephemeral port). The MJPEG route in
 * `app/api/task-browser/[taskId]/stream` republishes it through the admin's own
 * `/admin` origin, so it inherits Nginx + the session-cookie auth for free.
 */

const pExecFile = promisify(execFile);

// The daemon needs --no-sandbox on this host (Ubuntu 24.04 restricts the Chrome
// user-namespace sandbox). Also set as a global default in ~/.agent-browser/
// config.json, but we pass it explicitly so this works regardless of env.
const BIN = "agent-browser";
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  AGENT_BROWSER_ARGS: process.env.AGENT_BROWSER_ARGS ?? "--no-sandbox",
};

// Fixed viewport so screen coordinates <-> click coordinates map deterministically.
export const VIEWPORT = { width: 1280, height: 720 } as const;

/** Map an opaque task id to a safe agent-browser session name. */
export function sessionFor(taskId: string): string {
  const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
  return `task-${safe}`;
}

/** Run one agent-browser command scoped to a task's session. */
async function ab(taskId: string, args: string[]): Promise<string> {
  const { stdout } = await pExecFile(
    BIN,
    ["--session", sessionFor(taskId), ...args],
    { env: childEnv, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout;
}

/**
 * Ensure the task's browser exists and is on `url`. This lazily launches the
 * session's Chrome (first call) and pins the viewport. Safe to call repeatedly.
 */
export async function openUrl(taskId: string, url: string): Promise<void> {
  await ab(taskId, ["open", url]);
  await ab(taskId, [
    "set",
    "viewport",
    String(VIEWPORT.width),
    String(VIEWPORT.height),
  ]).catch(() => {}); // non-fatal: some engines ignore viewport

  // Pre-warm the screencast. CDP only emits a frame on a visual change, so a
  // freshly-loaded static page yields nothing to the *first* stream client. A
  // brief throwaway connection here triggers the screencast and lands the first
  // frame in agent-browser's cache, so the user's <img> renders immediately.
  const port = await getStreamPort(taskId);
  if (port) await primeStream(port);
}

/** Connect to the stream once and wait for the first frame (or a short timeout). */
function primeStream(port: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?maxFps=4`);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve();
    };
    // Cap the wait so a genuinely blank page can't stall the open call.
    const timer = setTimeout(done, 5000);
    ws.on("message", (raw: WebSocket.RawData) => {
      try {
        if ((JSON.parse(raw.toString()) as { type?: string }).type === "frame") {
          done();
        }
      } catch {
        /* ignore non-JSON */
      }
    });
    ws.on("error", done);
  });
}

/** Localhost WebSocket port for the task's live viewport stream, or null. */
export async function getStreamPort(taskId: string): Promise<number | null> {
  let out: string;
  try {
    out = await ab(taskId, ["stream", "status", "--json"]);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(out);
    const port = parsed?.data?.port;
    return typeof port === "number" ? port : null;
  } catch {
    return null;
  }
}

/** Dispatch a real mouse click at absolute viewport coordinates. */
export async function clickAt(
  taskId: string,
  x: number,
  y: number,
): Promise<void> {
  const px = Math.round(Math.max(0, Math.min(VIEWPORT.width, x)));
  const py = Math.round(Math.max(0, Math.min(VIEWPORT.height, y)));
  await ab(taskId, ["mouse", "move", String(px), String(py)]);
  await ab(taskId, ["mouse", "down"]);
  await ab(taskId, ["mouse", "up"]);
}
