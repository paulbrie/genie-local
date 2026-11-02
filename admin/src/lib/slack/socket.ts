import "server-only";

import WebSocket from "ws";

/**
 * Slack's Web API and a Socket Mode connection, without Slack's SDKs: the bot
 * needs a handful of methods and one socket. Socket Mode means Slack is never
 * the one to connect: the box opens the socket (apps.connections.open with the
 * app-level token), so nothing new is exposed through nginx.
 */

// SLACK_API_URL points the bot at a stand-in Slack (tests); response_urls are then allowed there too.
const API = process.env.SLACK_API_URL || "https://slack.com/api/";

export class SlackError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`slack ${method}: ${code}`);
  }
}

/** Calls a Web API method with a JSON body; throws SlackError when Slack answers `ok: false`. */
export async function slackApi<T = Record<string, unknown>>(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + method, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    // Rate limited: wait as long as Slack says, once or twice.
    if (res.status === 429 && attempt < 2) {
      const wait = Number(res.headers.get("retry-after")) || 1;
      await new Promise((r) => setTimeout(r, Math.min(wait, 30) * 1000));
      continue;
    }
    const json = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as {
      ok: boolean;
      error?: string;
    };
    if (!json.ok) throw new SlackError(method, json.error ?? "unknown_error");
    return json as T;
  }
}

/** Posts to a slash command's response_url (good for 30 minutes, five times). */
export async function respond(url: string, message: Record<string, unknown>): Promise<void> {
  if (!url.startsWith("https://hooks.slack.com/") && !url.startsWith(new URL(API).origin + "/")) return;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {});
}

export type Envelope = {
  envelope_id: string;
  type: "events_api" | "slash_commands" | "interactive" | string;
  payload: Record<string, unknown>;
  retry_attempt?: number;
};

const PING_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Keeps one Socket Mode connection open: acknowledges every envelope at once (Slack
 * wants that within 3 s; the work runs after) and reconnects on Slack's
 * `disconnect` (it rotates sockets every few hours), on a close, or on a ping
 * that gets no pong.
 */
export class SocketMode {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 2000;
  private pingTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly appToken: string,
    private readonly onEnvelope: (e: Envelope) => void,
    private readonly log: (msg: string) => void,
  ) {}

  start() {
    this.stopped = false;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.drop();
  }

  private drop() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on("error", () => {});
      ws.terminate();
    }
  }

  private retry(why: string) {
    this.drop();
    if (this.stopped || this.retryTimer) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.log(`socket: ${why}; reconnecting in ${Math.round(wait / 1000)}s`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, wait);
    this.retryTimer.unref();
  }

  private async connect() {
    if (this.stopped) return;
    let url: string;
    try {
      ({ url } = await slackApi<{ url: string }>(this.appToken, "apps.connections.open"));
    } catch (e) {
      this.retry((e as Error).message);
      return;
    }
    const ws = new WebSocket(url);
    this.ws = ws;
    let alive = true;
    ws.on("open", () => {
      this.pingTimer = setInterval(() => {
        if (!alive) {
          this.retry("no pong");
          return;
        }
        // Anything heard back by the next tick (a pong, a message) keeps it.
        alive = false;
        ws.ping();
      }, PING_MS);
      this.pingTimer.unref();
    });
    ws.on("pong", () => (alive = true));
    ws.on("ping", () => (alive = true));
    ws.on("message", (data) => {
      alive = true;
      let msg: { type?: string; envelope_id?: string; reason?: string } & Partial<Envelope>;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === "hello") {
        this.backoff = 2000;
        this.log("socket: connected");
        return;
      }
      if (msg.type === "disconnect") {
        // Slack is about to close this one (refresh_requested, link_disabled…): open a fresh socket now.
        this.drop();
        if (msg.reason === "link_disabled") {
          this.log("socket: Socket Mode was turned off for the app");
          this.retry("link disabled");
          return;
        }
        void this.connect();
        return;
      }
      if (msg.envelope_id) {
        ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
        try {
          this.onEnvelope(msg as Envelope);
        } catch (e) {
          this.log(`handler: ${(e as Error).message}`);
        }
      }
    });
    ws.on("close", (code) => {
      if (this.ws === ws) this.retry(`closed (${code})`);
    });
    ws.on("error", (e) => {
      if (this.ws === ws) this.retry(e.message);
    });
  }
}
