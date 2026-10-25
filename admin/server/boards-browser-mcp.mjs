#!/usr/bin/env node
/**
 * A browser for Claude on boards, as a stdio MCP server over `agent-browser`.
 * The board hub hands it to the Claude CLI (see boards-claude.mjs) instead of a
 * shell: Claude gets browser actions only (open, read, click, type, scroll,
 * back), never a command line, because whatever people write on a board is,
 * in effect, Claude's prompt.
 *
 * The browser runs on the server, so it is fenced off from the server itself:
 * only http(s) URLs, nothing that resolves to loopback, private, link-local or
 * otherwise internal addresses (no file://, no 127.0.0.1:3002, no LAN), checked
 * before opening and again after every action in case a click lands there.
 * Each run gets its own throwaway browser session (BOARDS_BROWSER_SESSION),
 * with none of anyone's cookies, closed when the CLI disconnects.
 */
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createInterface } from "node:readline";

const SESSION = process.env.BOARDS_BROWSER_SESSION || `board-claude-${process.pid}`;
const MAX_TEXT = 30_000;
let launched = false;

function ab(args, timeoutMs = 45_000) {
  // First call starts the browser (no sandbox on this VM); later calls reuse it.
  const pre = ["--session", SESSION, ...(launched ? [] : ["--args", "--no-sandbox"])];
  launched = true;
  return new Promise((resolve, reject) => {
    execFile("agent-browser", [...pre, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout).replace(/^⚠ --args ignored.*\n/gm, "").trim();
      if (err) reject(new Error((String(stderr).trim() || out || err.message).slice(0, 500)));
      else resolve(out);
    });
  });
}

// ------------------------------------------------------------------ the fence

function privateV4(ip) {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  );
}
function privateIp(ip) {
  if (isIP(ip) === 4) return privateV4(ip);
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return privateIp(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff");
}

/** Throws unless `raw` is an http(s) URL on a public address. */
async function checkUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`only http(s) pages (got ${url.protocol})`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("internal addresses are off limits");
  }
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error(`can't resolve ${host}`);
  if (addrs.some((a) => privateIp(a.address))) throw new Error("internal addresses are off limits");
  return url.href;
}

/** After an action: if the page ended up somewhere internal, leave it. */
async function guard() {
  const url = await ab(["get", "url"]).catch(() => "about:blank");
  if (url === "about:blank") return url;
  try {
    await checkUrl(url);
    return url;
  } catch (e) {
    await ab(["open", "about:blank"]).catch(() => {});
    throw new Error(`the page went to a blocked address (${e.message}); left it`);
  }
}

const clip = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n…(cut at ${MAX_TEXT} characters)` : s);
const REF = /^@?e\d{1,5}$/;
const ref = (r) => {
  if (typeof r !== "string" || !REF.test(r)) throw new Error('ref must look like "e12" (from browser_snapshot)');
  return r.startsWith("@") ? r : `@${r}`;
};

// ------------------------------------------------------------------ tools

const TOOLS = [
  {
    name: "browser_open",
    description: "Open a public web page (http/https) in a real browser, so pages that need JavaScript work. Returns the page's text.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    run: async ({ url }) => {
      await ab(["open", await checkUrl(url)], 60_000);
      const at = await guard();
      await ab(["wait", "1200"]).catch(() => {});
      return `Opened ${at}\n\n${clip(await ab(["get", "text", "body"]))}`;
    },
  },
  {
    name: "browser_text",
    description: "The current page's visible text (after scrolling, clicking or waiting).",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const at = await guard();
      return `${at}\n\n${clip(await ab(["get", "text", "body"]))}`;
    },
  },
  {
    name: "browser_snapshot",
    description: 'The page\'s interactive elements (links, buttons, inputs) with refs like "e12" to use with browser_click and browser_type.',
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const at = await guard();
      return `${at}\n\n${clip(await ab(["snapshot", "-i"]))}`;
    },
  },
  {
    name: "browser_click",
    description: 'Click an element by its ref from browser_snapshot (e.g. "e12"). Returns where the page is afterwards.',
    inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
    run: async (a) => {
      await ab(["click", ref(a.ref)]);
      await ab(["wait", "800"]).catch(() => {});
      return `Clicked; now at ${await guard()}`;
    },
  },
  {
    name: "browser_type",
    description: "Fill a text input (by ref from browser_snapshot), optionally pressing Enter after.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } },
      required: ["ref", "text"],
    },
    run: async (a) => {
      await ab(["fill", ref(a.ref), String(a.text).slice(0, 2000)]);
      if (a.submit) {
        await ab(["press", "Enter"]);
        await ab(["wait", "1200"]).catch(() => {});
      }
      return `Typed; now at ${await guard()}`;
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the page down or up (e.g. to load more content), then read it with browser_text.",
    inputSchema: {
      type: "object",
      properties: { direction: { type: "string", enum: ["down", "up"] }, pixels: { type: "integer" } },
      required: ["direction"],
    },
    run: async (a) => {
      const px = Math.min(5000, Math.max(100, Number(a.pixels) || 900));
      await ab(["scroll", a.direction === "up" ? "up" : "down", String(px)]);
      return `Scrolled; at ${await guard()}`;
    },
  },
  {
    name: "browser_back",
    description: "Go back to the previous page.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      await ab(["back"]).catch(() => {});
      return `Back at ${await guard()}`;
    },
  },
];

// ------------------------------------------------------------------ MCP (stdio JSON-RPC)

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return;
  if (method === "initialize") {
    return send({
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "boards-browser", version: "1.0.0" },
      },
    });
  }
  if (method === "ping") return send({ id, result: {} });
  if (method === "tools/list") {
    return send({ id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  }
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return send({ id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
    try {
      return send({ id, result: { content: [{ type: "text", text: await tool.run(params.arguments ?? {}) }] } });
    } catch (e) {
      return send({ id, result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true } });
    }
  }
  return send({ id, error: { code: -32601, message: `method not found: ${method}` } });
});

// The CLI is done with us: close this run's browser.
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  if (!launched) process.exit(0);
  execFile("agent-browser", ["--session", SESSION, "close"], { timeout: 10_000 }, () => process.exit(0));
}
rl.on("close", shutdown);
process.on("SIGTERM", shutdown);
