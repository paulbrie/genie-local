#!/usr/bin/env node
/**
 * MCP server (stdio) that lets a Claude Code session, or any MCP client, drive
 * the tabs people share with Spiridus through the Spiridus Bridge extension
 * (/browsers): list browsers and tabs, open and navigate, read a page (its
 * interactive elements with refs, its text, a screenshot), click, type, press
 * keys, scroll, run JavaScript, any DevTools command, and read the console.
 * A thin client of the HTTP API in src/app/api/browsers; no dependencies.
 *
 *   claude mcp add browsers -- node /opt/project/admin/scripts/browsers-mcp.mjs
 *
 * Credentials as in boards-mcp.mjs: BROWSERS_API_KEY (environment, else the
 * admin's .env.local), else the admin's own ADMIN_USER / ADMIN_PASSWORD
 * session. BROWSERS_URL is the admin's origin + basePath (prod listens on
 * 127.0.0.1:3002; going through nginx works too).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const BASE = (process.env.BROWSERS_URL ?? "http://127.0.0.1:3002/admin").replace(/\/$/, "");

/** One value out of the admin's .env.local. */
function fromEnvFile(name) {
  try {
    const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    return env.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1].trim().replace(/^["']|["']$/g, "") ?? "";
  } catch {
    return "";
  }
}

const KEY = process.env.BROWSERS_API_KEY || fromEnvFile("BROWSERS_API_KEY");
// The name on the cursor people see in the tab (the extension's overlay): BROWSERS_AGENT, else the Spiridus terminal
// this runs in (its tmux session, "admin-<name>"), else "Claude".
function terminalName() {
  if (!process.env.TMUX) return "";
  try {
    return execFileSync("tmux", ["display-message", "-p", "#S"], { encoding: "utf8", timeout: 2000 }).trim().replace(/^admin-/, "");
  } catch {
    return "";
  }
}
const AGENT = (process.env.BROWSERS_AGENT || terminalName() || "Claude").slice(0, 40);

let cookie = null;
async function signIn() {
  if (cookie) return cookie;
  const username = process.env.ADMIN_USER || fromEnvFile("ADMIN_USER");
  const password = process.env.ADMIN_PASSWORD || fromEnvFile("ADMIN_PASSWORD");
  if (!username || !password) return null;
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(BASE).origin },
    body: JSON.stringify({ username, password }),
  });
  const set = res.headers.get("set-cookie") ?? "";
  cookie = res.ok && set.startsWith("admin_session=") ? set.split(";")[0] : null;
  return cookie;
}

async function api(path, init = {}) {
  const url = `${BASE}/api/browsers${path}`;
  const send = (extra) =>
    fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", Origin: new URL(BASE).origin, ...extra, ...(init.headers ?? {}) },
    });
  let res = KEY ? await send({ "x-api-key": KEY }) : await send(cookie ? { Cookie: cookie } : {});
  if (res.status === 401 && (await signIn())) res = await send({ Cookie: cookie });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

/** The browser a tool means: the one given, else the only connected one. */
let lastBrowser = null;
async function browserId(a) {
  if (a.browser) return (lastBrowser = Number(a.browser));
  if (lastBrowser) return lastBrowser;
  const { browsers } = await api("");
  const online = browsers.filter((b) => b.online);
  if (online.length === 1) return (lastBrowser = online[0].id);
  if (!online.length) throw new Error("no browser is connected: pair one on Spiridus's Browsers page and keep Chrome open");
  throw new Error(`${online.length} browsers are connected (${online.map((b) => `${b.id} ${b.name}`).join(", ")}): pass browser`);
}

async function cmd(type, a = {}, timeoutMs) {
  const { browser, ...args } = a;
  const id = await browserId({ browser });
  const r = await api(`/${id}/command`, { method: "POST", body: JSON.stringify({ type, args: { by: AGENT, ...args }, ...(timeoutMs ? { timeoutMs } : {}) }) });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

const text = (v) => [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }];
const browserArg = { browser: { type: "number", description: "browser id (browsers_list); default: the only connected one" } };
const tabArg = { ...browserArg, tabId: { type: "number", description: "default: the only shared tab, else the active one when it's shared" } };
const where = {
  ...tabArg,
  ref: { type: "string", description: "an element ref from browser_snapshot, e.g. e12 (best)" },
  selector: { type: "string", description: "a CSS selector instead" },
  text: { type: "string", description: "visible text instead (the innermost element with it)" },
  nth: { type: "number", description: "0-based, when several match selector/text" },
  x: { type: "number", description: "or a point: CSS px from the viewport's left" },
  y: { type: "number" },
};
const obj = (properties, required) => ({ type: "object", properties, ...(required ? { required } : {}) });

const TOOLS = [
  {
    name: "browsers_list",
    description: "The browsers paired with Spiridus (the Spiridus Bridge extension): which are connected, and the tabs each shares with you.",
    inputSchema: obj({}),
    run: async () => {
      const { browsers } = await api("");
      if (!browsers.length) return text("No browser paired: someone pairs one on Spiridus's Browsers page.");
      return text(
        browsers
          .map((b) =>
            [`#${b.id} ${b.name} — ${b.online ? "connected" : "offline"}${b.online && b.unsharedTabs ? ` (${b.unsharedTabs} tabs not shared)` : ""}`]
              .concat(b.tabs.map((t) => `   tab ${t.id}${t.active ? " (active)" : ""}${t.opened ? " (opened by Spiridus)" : ""}: ${t.title} — ${t.url}`))
              .join("\n"),
          )
          .join("\n"),
      );
    },
  },
  {
    name: "browser_open",
    description: "Open a new tab in the person's browser at an http(s) URL (it's shared with you, marked as opened by Spiridus); waits for it to load.",
    inputSchema: obj({ ...browserArg, url: { type: "string" }, active: { type: "boolean", description: "bring it to the front (default true)" } }, ["url"]),
    run: async (a) => text(await cmd("open", a)),
  },
  {
    name: "browser_navigate",
    description: "Go to a URL in a tab, or back / forward / reload it; waits for the load.",
    inputSchema: obj({ ...tabArg, url: { type: "string" }, action: { type: "string", enum: ["back", "forward", "reload"] } }),
    run: async ({ action, ...a }) => text(await cmd(action ?? "navigate", a)),
  },
  {
    name: "browser_tab",
    description: "Bring a tab to the front (needed for screenshots of a background tab) or close it.",
    inputSchema: obj({ ...tabArg, action: { type: "string", enum: ["activate", "close"] } }, ["action"]),
    run: async ({ action, ...a }) => text(await cmd(action, a)),
  },
  {
    name: "browser_snapshot",
    description: "Read a page: URL, title, scroll position, its interactive elements one per line with refs ([e12] button \"Save\") and headings, and its visible text. Use the refs with browser_click / browser_type. Take a new one after the page changes.",
    inputSchema: obj({ ...tabArg, maxText: { type: "number", description: "how much page text (default 4000 chars)" } }),
    run: async (a) => {
      const s = await cmd("snapshot", a);
      return text(`${s.title}\n${s.url}\nviewport ${s.viewport.width}×${s.viewport.height}, scrolled to ${s.viewport.scrollY} of ${s.viewport.scrollHeight}\n\n${s.elements}\n\n--- text ---\n${s.text}`);
    },
  },
  {
    name: "browser_screenshot",
    description: "A screenshot of a tab (what's in its viewport, or the full page). The tab must be visible: bring it to the front first if needed.",
    inputSchema: obj({ ...tabArg, fullPage: { type: "boolean" } }),
    run: async (a) => {
      const s = await cmd("screenshot", { ...a, quality: 70 });
      const [, mimeType, data] = s.dataUrl.match(/^data:([^;]+);base64,(.*)$/);
      return [
        { type: "image", mimeType, data },
        { type: "text", text: `viewport ${s.viewport.width}×${s.viewport.height} CSS px (x, y for clicks are in these)` },
      ];
    },
  },
  {
    name: "browser_click",
    description: "Click (real mouse events) an element, by ref, selector or text, or a point. Scrolls it into view first; says if something covers it.",
    inputSchema: obj({ ...where, button: { type: "string", enum: ["left", "right", "middle"] }, clickCount: { type: "number", description: "2 for a double click" }, hover: { type: "boolean", description: "only move the mouse there" } }),
    run: async ({ hover, ...a }) => text(await cmd(hover ? "hover" : "click", a)),
  },
  {
    name: "browser_type",
    description: "Type text (as if typed), into an element (clicked first) or wherever the focus is. clear replaces what's there; submit presses Enter after.",
    inputSchema: obj({ ...tabArg, text: { type: "string" }, ref: where.ref, selector: where.selector, clear: { type: "boolean" }, submit: { type: "boolean" } }, ["text"]),
    run: async (a) => text(await cmd("type", a)),
  },
  {
    name: "browser_key",
    description: "Press keys: \"Enter\", \"Escape\", \"Tab\", \"ArrowDown\", \"Control+a\", \"Shift+Tab\"…; several separated by spaces.",
    inputSchema: obj({ ...tabArg, key: { type: "string" } }, ["key"]),
    run: async (a) => text(await cmd("key", a)),
  },
  {
    name: "browser_scroll",
    description: "Scroll with the mouse wheel (dy > 0 down), at a point or the middle of the viewport.",
    inputSchema: obj({ ...tabArg, dy: { type: "number" }, dx: { type: "number" }, x: { type: "number" }, y: { type: "number" } }),
    run: async (a) => text(await cmd("scroll", a)),
  },
  {
    name: "browser_select",
    description: "Pick an option of a <select> by its value or label.",
    inputSchema: obj({ ...tabArg, ref: where.ref, selector: where.selector, value: { type: "string" } }, ["value"]),
    run: async (a) => text(await cmd("select", a)),
  },
  {
    name: "browser_wait",
    description: "Wait until a selector matches or a text shows up in the page (up to timeoutMs, default 10000).",
    inputSchema: obj({ ...tabArg, selector: { type: "string" }, text: { type: "string" }, timeoutMs: { type: "number" } }),
    run: async (a) => text(await cmd("wait", a, (Number(a.timeoutMs) || 10_000) + 5000)),
  },
  {
    name: "browser_eval",
    description: "Run JavaScript in the page (like the DevTools console: top-level await works) and get its value as JSON.",
    inputSchema: obj({ ...tabArg, expression: { type: "string" } }, ["expression"]),
    run: async (a) => text(await cmd("eval", a)),
  },
  {
    name: "browser_read",
    description: "A page's HTML (whole, or one element's by selector) or its plain text.",
    inputSchema: obj({ ...tabArg, what: { type: "string", enum: ["html", "text"] }, selector: { type: "string" }, max: { type: "number", description: "chars (default 20000)" } }, ["what"]),
    run: async ({ what, ...a }) => text(await cmd(what, a)),
  },
  {
    name: "browser_dialog",
    description: "Answer an alert / confirm / prompt the page opened (it blocks the page until answered).",
    inputSchema: obj({ ...tabArg, accept: { type: "boolean" }, promptText: { type: "string" } }),
    run: async (a) => text(await cmd("dialog", a)),
  },
  {
    name: "browser_cdp",
    description: "Any Chrome DevTools Protocol command in a tab, e.g. Network.getCookies, Emulation.setDeviceMetricsOverride, DOM.getDocument. subscribe: forward these CDP events (read them with browser_events), e.g. [\"Network.responseReceived\"] after Network.enable.",
    inputSchema: obj({ ...tabArg, method: { type: "string" }, params: { type: "object" }, subscribe: { type: "array", items: { type: "string" } } }),
    run: async ({ subscribe, ...a }) => text(subscribe ? await cmd("subscribe", { ...a, methods: subscribe }) : await cmd("cdp", a)),
  },
  {
    name: "browser_events",
    description: "What happened since you last looked: console messages, page errors, navigations, dialogs, tabs shared or unshared, subscribed CDP events. wait: seconds to wait for one when there are none (max 60).",
    inputSchema: obj({ ...browserArg, wait: { type: "number" } }),
    run: async (a) => {
      const id = await browserId(a);
      const r = await api(`/${id}/events?after=${seen.get(id) ?? 0}&wait=${Math.min(Number(a.wait) || 0, 60)}`);
      seen.set(id, r.seq);
      if (!r.events.length) return text("Nothing new.");
      return text(r.events.map((e) => `${new Date(e.at).toISOString().slice(11, 19)} ${e.kind}${e.tabId ? ` [tab ${e.tabId}]` : ""} ${JSON.stringify(e.data ?? {})}`).join("\n"));
    },
  },
];
const seen = new Map();

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled)
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "spiridus-browsers", version: "1.0.0" },
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `unknown tool ${params?.name}`);
      try {
        return reply(id, { content: await tool.run(params.arguments ?? {}) });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
});
