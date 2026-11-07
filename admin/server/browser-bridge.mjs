/**
 * The browser bridge: Spiridus driving tabs of people's own Chrome, through the
 * Spiridus Bridge extension (../extension), hosted in the custom server next to
 * the PTY and board sockets (see server.mjs).
 *
 * Pairing. Someone signed in to Spiridus asks for a code on /browsers
 * (`hub.createPairCode`, 10 minutes, single use) and types it into the
 * extension's popup. The extension connects to `<basePath>/browser-ws` and
 * claims it; the hub stores a new `browser_links` row (only the token's
 * SHA-256) and hands the token back. From then on the extension says hello with
 * that token on every connection, so it reconnects by itself after a restart on
 * either side. Revoking the row (/browsers, `hub.revoke`) drops the socket and
 * the token stops working. The socket's Origin is the extension's
 * (chrome-extension://…), so the token is the whole of its auth, never the
 * admin_session cookie.
 *
 * Commands. The Next routes under src/app/api/browsers (cookie, or
 * BROWSERS_API_KEY for agents) reach this hub through `globalThis.__browserBridge`
 * since Next runs in this process: `hub.command(id, type, args)` sends
 * `{t:"cmd", id, type, args}` and resolves with the extension's
 * `{t:"result", id, ok, data | error}`. The extension only acts in tabs its user
 * shared from the popup (or that Spiridus opened), through chrome.debugger, so a
 * command can do anything DevTools can: see background.js for the list.
 *
 * Events (console messages, errors, navigations, dialogs, tabs shared or not)
 * go into a ring per browser, read with `hub.events(id, after, waitMs)`.
 *
 * Wire protocol (JSON frames):
 *   extension → hub                        hub → extension
 *   claim {code, name, info}               paired {id, name, token}
 *   hello {token, info}                    welcome {id, name}
 *   tabs {tabs, unshared}                  cmd {id, type, args}
 *   result {id, ok, data?, error?}         pong {}
 *   event {kind, tabId?, data}
 *   ping {}
 *   unpair {}
 *   state {state}                          (Spiridus Desktop: its displays, OS, what it may do)
 *
 * A claim says its `kind`: "chrome" (the extension) or "desktop" (Spiridus Desktop, admin/desktop: a whole
 * computer, its screens, input, files and shell). Both share everything here; only the commands differ.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import pg from "pg";

const CODE_TTL_MS = 10 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// A wrong code costs a try; this many per address per window, then the socket is refused.
const CLAIM_TRIES = 10;
const CLAIM_WINDOW_MS = 10 * 60_000;
const HELLO_WITHIN_MS = 10_000;
const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MAX_MS = 180_000;
const EVENTS_KEPT = 500;
const SEEN_EVERY_MS = 60_000;

let pool;
function db() {
  // Lazy: server.mjs loads .env.local after this module is imported.
  pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  return pool;
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** code → { createdBy, expiresAt } */
const codes = new Map();
/** ip → { tries, until } */
const claimTries = new Map();
/** link id → Browser (connected ones) */
const browsers = new Map();
/** link id → { seq, list, waiters } — kept after a disconnect, so events can still be read */
const rings = new Map();

function newCode() {
  let c = "";
  for (let i = 0; i < 8; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
const normCode = (c) => {
  const s = String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : "";
};

function sweepCodes() {
  const now = Date.now();
  for (const [c, v] of codes) if (v.expiresAt < now) codes.delete(c);
  for (const [ip, v] of claimTries) if (v.until < now) claimTries.delete(ip);
}

function ring(id) {
  let r = rings.get(id);
  if (!r) rings.set(id, (r = { seq: 0, list: [], waiters: new Set() }));
  return r;
}
function pushEvent(id, ev) {
  const r = ring(id);
  r.list.push({ seq: ++r.seq, at: Date.now(), ...ev });
  if (r.list.length > EVENTS_KEPT) r.list.splice(0, r.list.length - EVENTS_KEPT);
  for (const w of r.waiters) w();
  r.waiters.clear();
}

const cleanInfo = (v) => {
  const o = v && typeof v === "object" ? v : {};
  const str = (x, n = 300) => (typeof x === "string" ? x.slice(0, n) : undefined);
  return {
    userAgent: str(o.userAgent),
    platform: str(o.platform, 60),
    version: str(o.version, 30),
    // Spiridus Desktop (admin/desktop) says these instead of a user agent
    os: str(o.os, 80),
    hostname: str(o.hostname, 120),
    user: str(o.user, 80),
  };
};
/** What a pairing is: the Chrome extension, or the Spiridus Desktop app (a whole computer). */
const KINDS = new Set(["chrome", "desktop"]);
/** A desktop's state as it reports it (its displays, what it may do), kept small. */
const cleanState = (v) => {
  const o = v && typeof v === "object" ? v : {};
  const json = JSON.stringify(o);
  return json.length > 20_000 ? {} : o;
};

class Browser {
  constructor(ws, link, info, ip) {
    this.ws = ws;
    this.id = link.id;
    this.name = link.name;
    this.info = info;
    this.ip = ip;
    this.connectedAt = Date.now();
    this.kind = link.kind ?? "chrome";
    this.tabs = [];
    this.unshared = 0;
    this.state = {};
    this.pending = new Map();
    this.nextCmd = 1;
    this.seenAt = 0;
  }
  send(msg) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }
  command(type, args, timeoutMs) {
    const id = this.nextCmd++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the browser didn't answer "${type}" within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ t: "cmd", id, type, args });
    });
  }
  failAll(why) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
    }
    this.pending.clear();
  }
  touch() {
    const now = Date.now();
    if (now - this.seenAt < SEEN_EVERY_MS) return;
    this.seenAt = now;
    db().query("update browser_links set last_seen_at = now() where id = $1", [this.id]).catch(() => {});
  }
  summary() {
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      online: true,
      connectedAt: this.connectedAt,
      ip: this.ip,
      info: this.info,
      tabs: this.tabs,
      unsharedTabs: this.unshared,
      state: this.state,
    };
  }
}

function attach(ws, link, info, ip) {
  const prev = browsers.get(link.id);
  if (prev) {
    prev.failAll("the browser reconnected");
    prev.ws.close(4409, "replaced by a newer connection");
  }
  const b = new Browser(ws, link, info, ip);
  browsers.set(link.id, b);
  b.touch();
  pushEvent(link.id, { kind: "connected", data: { ip } });
  return b;
}

/** One extension socket, from upgrade to close. `ip` is the client's address (for claim throttling). */
export function handleBrowserConnection(ws, ip) {
  let browser = null;
  const helloTimer = setTimeout(() => ws.close(4401, "no hello"), HELLO_WITHIN_MS);

  const refuse = (code, reason) => {
    try {
      ws.send(JSON.stringify({ t: "refused", reason }));
    } catch {
      /* closing anyway */
    }
    ws.close(code, reason);
  };

  const onMessage = async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (!browser) {
      if (msg.t === "hello" && typeof msg.token === "string") {
        clearTimeout(helloTimer);
        const info = cleanInfo(msg.info);
        let rows;
        try {
          ({ rows } = await db().query("select id, name, kind from browser_links where token_hash = $1 and revoked_at is null", [sha256(msg.token)]));
        } catch {
          // Not 4401: that makes the extension forget its token, and this is only Spiridus having a moment.
          return refuse(1011, "Spiridus couldn't check the pairing just now");
        }
        if (!rows[0]) return refuse(4401, "unknown or revoked pairing: pair this browser again");
        db().query("update browser_links set info = $2 where id = $1", [rows[0].id, info]).catch(() => {});
        browser = attach(ws, rows[0], info, ip);
        browser.send({ t: "welcome", id: browser.id, name: browser.name });
        return;
      }
      if (msg.t === "claim") {
        clearTimeout(helloTimer);
        sweepCodes();
        const tries = claimTries.get(ip) ?? { tries: 0, until: Date.now() + CLAIM_WINDOW_MS };
        if (tries.tries >= CLAIM_TRIES) return refuse(4429, "too many wrong codes: wait a few minutes");
        const code = normCode(msg.code);
        const entry = code && codes.get(code);
        if (!entry) {
          tries.tries++;
          claimTries.set(ip, tries);
          return refuse(4401, "wrong or expired code: make a new one on Spiridus's Browsers page");
        }
        codes.delete(code);
        const info = cleanInfo(msg.info);
        const kind = KINDS.has(msg.kind) ? msg.kind : "chrome";
        const name = (typeof msg.name === "string" && msg.name.trim().slice(0, 80)) || (kind === "desktop" ? (info.hostname ?? "Computer") : "Chrome");
        const token = randomBytes(32).toString("base64url");
        const { rows } = await db().query(
          "insert into browser_links (name, token_hash, created_by, info, kind) values ($1, $2, $3, $4, $5) returning id, name, kind",
          [name, sha256(token), entry.createdBy, info, kind],
        );
        browser = attach(ws, rows[0], info, ip);
        browser.send({ t: "paired", id: browser.id, name: browser.name, token });
        return;
      }
      return;
    }

    browser.touch();
    switch (msg.t) {
      case "ping":
        browser.send({ t: "pong" });
        return;
      case "tabs":
        browser.tabs = Array.isArray(msg.tabs) ? msg.tabs.slice(0, 200) : [];
        browser.unshared = Number(msg.unshared) || 0;
        return;
      case "state":
        browser.state = cleanState(msg.state);
        return;
      case "result": {
        const p = browser.pending.get(msg.id);
        if (!p) return;
        browser.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data ?? null);
        else p.reject(new Error(typeof msg.error === "string" ? msg.error : "the browser couldn't do it"));
        return;
      }
      case "unpair":
        // Unpaired from the extension's popup: the token is done for.
        db().query("update browser_links set revoked_at = now() where id = $1 and revoked_at is null", [browser.id]).catch(() => {});
        pushEvent(browser.id, { kind: "unpaired", data: {} });
        ws.close(4401, "unpaired");
        return;
      case "event":
        if (typeof msg.kind === "string") pushEvent(browser.id, { kind: msg.kind.slice(0, 60), tabId: msg.tabId, data: msg.data });
        return;
    }
  };

  // A failed query must not become an unhandled rejection: that would take the whole server down.
  ws.on("message", (raw) => onMessage(raw).catch(() => ws.close(1011, "Spiridus had an error")));

  ws.on("close", () => {
    clearTimeout(helloTimer);
    if (!browser) return;
    browser.failAll("the browser disconnected");
    if (browsers.get(browser.id) === browser) {
      browsers.delete(browser.id);
      pushEvent(browser.id, { kind: "disconnected", data: {} });
    }
  });
  ws.on("error", () => {});
}

const hub = {
  /** A single-use pairing code for the extension's popup. */
  createPairCode(createdBy) {
    sweepCodes();
    let code;
    do code = newCode();
    while (codes.has(code));
    const expiresAt = Date.now() + CODE_TTL_MS;
    codes.set(code, { createdBy: createdBy ?? null, expiresAt });
    return { code, expiresAt };
  },
  /** Connected browsers, live state only (the routes merge in browser_links). */
  connected() {
    return [...browsers.values()].map((b) => b.summary());
  },
  get(id) {
    return browsers.get(Number(id))?.summary() ?? null;
  },
  /** Run one command in a browser; resolves with its data, rejects with its error. */
  async command(id, type, args = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    const b = browsers.get(Number(id));
    if (!b) throw new Error("that browser isn't connected (is Chrome open, with the extension paired?)");
    const ms = Math.min(Math.max(Number(timeoutMs) || COMMAND_TIMEOUT_MS, 1000), COMMAND_TIMEOUT_MAX_MS);
    return b.command(type, args, ms);
  },
  /** Events after `after`, waiting up to `waitMs` for one when there are none yet. */
  async events(id, after = 0, waitMs = 0) {
    const r = ring(Number(id));
    const since = () => r.list.filter((e) => e.seq > after);
    if (!since().length && waitMs > 0) {
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          r.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(waitMs, 60_000));
        r.waiters.add(done);
      });
    }
    return { seq: r.seq, events: since() };
  },
  /** Drop a browser's socket now (after its row was revoked). */
  disconnect(id) {
    const b = browsers.get(Number(id));
    if (!b) return false;
    b.send({ t: "revoked" });
    b.ws.close(4401, "revoked");
    return true;
  },
};
globalThis.__browserBridge = hub;
