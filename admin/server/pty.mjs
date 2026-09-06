/**
 * PTY-over-WebSocket bridge for the admin custom server (see ../server.mjs).
 *
 * One WebSocket == one interactive terminal. On `pty:start {name,cols,rows}` we
 * spawn a real PTY running `tmux attach-session -t admin-<name>`, so the browser
 * xterm drives the SAME persistent tmux session the rest of the admin terminal
 * feature already manages (create/kill/rename/token-meter/status all keep
 * working — the PTY is just a live view). Closing the socket kills the attach
 * (detaches tmux; the session lives on).
 *
 * Wire protocol (JSON frames, one terminal per socket):
 *   client → server                 server → client
 *   pty:start  {name,cols,rows}     pty:ready  {}
 *   pty:data   {data}               pty:output {dataB64}
 *   pty:resize {cols,rows}          pty:exit   {exitCode}
 *                                   pty:error  {message}
 *
 * This file runs in the raw Node process (NOT through the Next build), so it is
 * plain ESM with no `@/` aliases and no TypeScript.
 */
import { createRequire } from "node:module";
import { execFile } from "node:child_process";

const require = createRequire(import.meta.url);
// node-pty & ws are CommonJS with native/typed exports — require() is the
// bullet-proof interop here (named ESM imports are flaky across their builds).
const pty = require("node-pty");

// ── Auth: mirror of src/lib/session.ts verifySessionToken ────────────────────
// Keep in sync with that file — same HMAC-SHA256 over the same cookie. The raw
// Node server can't import the app's TS, so this is a faithful port.
const SESSION_COOKIE = "admin_session";
const enc = new TextEncoder();

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function fromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return b64ToBytes(s);
}

async function getKey() {
  const raw = b64ToBytes(process.env.APP_ENC_KEY ?? "");
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function verifySessionToken(token) {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot === -1) return false;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expected;
  try {
    expected = new Uint8Array(
      await crypto.subtle.sign("HMAC", await getKey(), enc.encode(body)),
    );
  } catch {
    return false;
  }
  const got = fromB64url(sig);
  if (expected.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ got[i];
  if (diff !== 0) return false;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return typeof p.exp === "number" && p.exp > Date.now();
  } catch {
    return false;
  }
}

/** Pull one cookie value out of a Cookie header. */
export function getCookie(header, name = SESSION_COOKIE) {
  for (const part of (header || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

// ── tmux target: mirror of src/lib/terminals.ts toTarget ─────────────────────
const PREFIX = "admin-";
const FORBIDDEN = /[.:\x00-\x1f\x7f]/;
const MAX_NAME = 64;

/** Validate a user-supplied session name and return the full tmux target.
 *  Throws on anything that could break tmux target syntax or escape the prefix. */
export function toTarget(name) {
  if (
    !name ||
    typeof name !== "string" ||
    name.length > MAX_NAME ||
    name !== name.trim() ||
    FORBIDDEN.test(name)
  ) {
    throw new Error("invalid terminal name");
  }
  return PREFIX + name;
}

/** Mirror of terminals.ts clamp — keep tmux window dimensions sane. */
function clampSize(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// ── Output batching: mirror of genie ssh/session/output-batch.ts ─────────────
// Full-screen TUIs (Claude Code, vim) write many small chunks per frame;
// coalescing at 16ms yields ~one WS frame per render instead of one per chunk.
const OUTPUT_BATCH_MS = 16;

function makeBatcher(ws) {
  let parts = [];
  let timer = null;
  const flush = () => {
    timer = null;
    if (!parts.length) return;
    const combined = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    parts = [];
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "pty:output", payload: { dataB64: combined.toString("base64") } }));
    } catch { /* socket closed */ }
  };
  return {
    push(buf) {
      parts.push(buf);
      if (!timer) timer = setTimeout(flush, OUTPUT_BATCH_MS);
    },
    dispose() {
      if (timer) { clearTimeout(timer); timer = null; }
      parts = [];
    },
  };
}

// ── Connection handler ───────────────────────────────────────────────────────

function sendJson(ws, type, payload = {}) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify({ type, payload })); } catch { /* closed */ }
}

/** Wire one authenticated WebSocket to a tmux-attached PTY. */
export function handlePtyConnection(ws) {
  /** @type {import("node-pty").IPty | null} */
  let child = null;
  let batcher = null;
  let target = null;          // tmux target, captured on pty:start
  let resizeTimer = null;     // debounce for the resize-window follow-up
  let pendingSize = null;     // {cols, rows} awaiting resize-window

  // Pin the tmux WINDOW (not just this client's PTY) to the viewport size so
  // full-screen TUIs (Claude, vim, tmux status) reflow immediately on resize.
  // child.resize() only resizes THIS client; without resize-window tmux can keep
  // the window at its creation size and the browser resize does nothing visible.
  // Debounced so a drag coalesces into a single tmux call. Best-effort: a size
  // race or a session that just died is not worth surfacing.
  const applyWindowSize = () => {
    resizeTimer = null;
    if (!target || !pendingSize) return;
    const { cols, rows } = pendingSize;
    execFile(
      "tmux",
      ["resize-window", "-t", target, "-x", String(cols), "-y", String(rows)],
      () => { /* ignore: races, gone sessions, manual-size refusals */ },
    );
  };

  const dispose = () => {
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
    if (batcher) { batcher.dispose(); batcher = null; }
    if (child) { try { child.kill(); } catch { /* already dead */ } child = null; }
  };

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { type, payload } = msg || {};

    switch (type) {
      case "pty:start": {
        if (child) return; // one PTY per socket; ignore a second start
        try {
          target = toTarget(payload?.name);
        } catch (e) {
          sendJson(ws, "pty:error", { message: e instanceof Error ? e.message : "invalid name" });
          return;
        }
        const cols = Number.isInteger(payload?.cols) ? payload.cols : 80;
        const rows = Number.isInteger(payload?.rows) ? payload.rows : 24;
        try {
          // -t <target>: attach to the existing admin-<name> session. Args go
          // through argv (no shell), so a session name with spaces is safe and
          // there is no shell-injection surface. `toTarget` already blocked the
          // tmux metacharacters (`.`/`:`/controls) and enforced the admin- prefix.
          child = pty.spawn("tmux", ["attach-session", "-t", target], {
            name: "xterm-256color",
            cols,
            rows,
            env: { ...process.env, TERM: "xterm-256color" },
          });
        } catch (e) {
          sendJson(ws, "pty:error", { message: e instanceof Error ? e.message : "spawn failed" });
          return;
        }
        batcher = makeBatcher(ws);
        // Guard: a final chunk can fire after close/exit nulls `batcher`. An
        // unguarded throw here escapes node-pty's emitter and crashes the process.
        child.onData((data) => { if (batcher) batcher.push(Buffer.from(data, "utf8")); });
        child.onExit(({ exitCode }) => {
          if (batcher) { batcher.dispose(); batcher = null; }
          child = null;
          sendJson(ws, "pty:exit", { exitCode });
          // tmux attach exits non-zero when the session is gone / can't attach.
        });
        sendJson(ws, "pty:ready", {});
        return;
      }

      case "pty:data": {
        if (child && typeof payload?.data === "string" && payload.data.length) {
          try { child.write(payload.data); } catch { /* write race on close */ }
        }
        return;
      }

      case "pty:resize": {
        if (child && Number.isInteger(payload?.cols) && Number.isInteger(payload?.rows)) {
          try { child.resize(payload.cols, payload.rows); } catch { /* size race */ }
          // Follow up by reflowing the tmux window itself (debounced).
          pendingSize = {
            cols: clampSize(payload.cols, 20, 500),
            rows: clampSize(payload.rows, 5, 200),
          };
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(applyWindowSize, 120);
        }
        return;
      }

      default:
        return;
    }
  });

  ws.on("close", dispose);
  ws.on("error", dispose);
}
