#!/usr/bin/env node
/**
 * MCP server (stdio) that lets a Claude Code session, or any MCP client, take
 * part in the admin's whiteboards: list boards, read one, edit it live (the
 * people on it watch the agent's cursor make the changes) and create boards.
 * A thin client of the HTTP API in src/app/api/boards; no dependencies.
 *
 *   claude mcp add boards \
 *     -e BOARDS_AGENT=<the name on your cursor> \
 *     -- node /opt/project/admin/scripts/boards-mcp.mjs
 *
 * The key is read from the admin's own .env.local, so it stays in one place
 * rather than being copied into an MCP config; BOARDS_API_KEY in the
 * environment overrides it. If there is no key — or the admin was started
 * before one was added, so it doesn't know it — this signs in with the admin's
 * own ADMIN_USER / ADMIN_PASSWORD and uses that session instead, which needs no
 * restart. Either way the credentials stay inside this process.
 *
 * BOARDS_URL is the admin's own origin + basePath, straight to the app (prod
 * listens on 127.0.0.1:3002; going through nginx works too).
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const BASE = (process.env.BOARDS_URL ?? "http://127.0.0.1:3002/admin").replace(/\/$/, "");

/** One value out of the admin's .env.local. */
function fromEnvFile(name) {
  try {
    const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    return env.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1].trim().replace(/^["']|["']$/g, "") ?? "";
  } catch {
    return "";
  }
}

const KEY = process.env.BOARDS_API_KEY || fromEnvFile("BOARDS_API_KEY");

/** A signed-in session, for when the key isn't an option. Fetched once. */
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
const AGENT = process.env.BOARDS_AGENT ?? "agent";

async function api(path, init = {}) {
  const url = `${BASE}/api/boards${path}`;
  const send = (extra) =>
    fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", Origin: new URL(BASE).origin, ...extra, ...(init.headers ?? {}) },
    });

  let res = KEY ? await send({ "x-api-key": KEY }) : await send(cookie ? { Cookie: cookie } : {});
  // No key, or an admin that was started before the key existed: sign in and
  // go again. Only worth one retry.
  if (res.status === 401 && (await signIn())) res = await send({ Cookie: cookie });

  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 500)}`);
  return text;
}

const OPS_DOC = `Ops, applied in order (all fields optional unless shown):
- {"op":"create","ref":"n1","type":"sticky|text|shape|section|link|task|table|comment", …}
  · sticky / text — "text" (markdown: **bold**, lists, tables, [links](url)); text takes "fontSize"
  · shape — "shape":"rect|roundrect|ellipse|diamond|triangle" with "text"
  · section — a titled frame: "title", "w", "h"; it sits behind what it groups, so leave ~40px round them. "collapsed":true folds it to a bar
  · link — "url" (http(s)), and optionally "title" and "desc"; draws as a card
  · task — "project" (a project's slug on this server) and "taskId" (one of its tickets), optionally "title"; a Link card to the ticket showing its live status
  · table — "rows":[["Header","Header"],["cell","cell"]]; the first row is the header
  · comment — "text" starts the thread
  "ref" names the new item for later ops in the same call; omit x/y to let the board find free space.
  Colours: yellow, orange, red, pink, purple, blue, teal, green, gray, white.
- {"op":"connect","from":"<id or ref>","to":"<id or ref>","label":"…"}
  Lines curve and meet each shape square-on; pass "straight":true for a plain one.
- {"op":"update","id":"<id or ref>", …fields to change}
- {"op":"delete","id":"<id>"}
- {"op":"reply","id":"<comment id>","text":"…"}
- {"op":"arrange","id":"<section id>"}  tidy a frame's contents onto a grid and size the frame to match
- {"op":"fit","id":"<section id>"}      size a frame around what it already holds
Coordinates are board pixels, x right, y down, x/y = top-left.`;

const TOOLS = [
  {
    name: "boards_list",
    description: "List the admin's whiteboards (id, title, item count, last edit).",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const rows = JSON.parse(await api(""));
      if (!rows.length) return "No boards.";
      return rows.map((b) => `#${b.id} ${b.title} (${b.items} items, edited ${b.updatedAt})`).join("\n");
    },
  },
  {
    name: "board_read",
    description:
      "Read a whiteboard: one JSON line per item (id, type, x, y, w, h, text, colour, the section it's in, votes, comment threads) and who is on it now.",
    inputSchema: {
      type: "object",
      properties: { board_id: { type: "integer" } },
      required: ["board_id"],
    },
    run: async ({ board_id }) => {
      const b = JSON.parse(await api(`/${board_id}`));
      const who = b.participants.length ? b.participants.map((p) => p.name).join(", ") : "nobody";
      const chat = b.doc.chat.slice(-10).map((m) => `${m.author.name}: ${m.text}`).join("\n");
      return `# ${b.title}\nOn the board now: ${who}\n\n${b.text || "(empty)"}${chat ? `\n\nRecent chat:\n${chat}` : ""}`;
    },
  },
  {
    name: "board_edit",
    description: `Change a whiteboard live, as a participant with your own cursor. ${OPS_DOC}`,
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "integer" },
        ops: { type: "array", items: { type: "object" } },
        chat: { type: "string", description: "Optional message to post in the board's chat." },
      },
      required: ["board_id", "ops"],
    },
    run: async ({ board_id, ops, chat }) => {
      const r = JSON.parse(await api(`/${board_id}/ops`, { method: "POST", body: JSON.stringify({ agent: AGENT, ops, chat }) }));
      const created = Object.entries(r.created).map(([ref, id]) => `${ref} → ${id}`).join(", ");
      return [
        `Applied ${r.applied} op(s).`,
        created && `Created: ${created}`,
        r.errors.length && `Skipped: ${r.errors.join("; ")}`,
        `\nBoard now:\n${r.text}`,
      ]
        .filter(Boolean)
        .join("\n");
    },
  },
  {
    name: "board_history",
    description:
      "The points a board can be rewound to — taken as people work, and before Claude or an agent changes anything. Useful for seeing what has been happening, or for telling someone which point to restore in the board's History panel.",
    inputSchema: { type: "object", properties: { board_id: { type: "integer" } }, required: ["board_id"] },
    run: async ({ board_id }) => {
      const rows = JSON.parse(await api(`/${board_id}/history`));
      if (!rows.length) return "Nothing kept yet for this board.";
      return rows
        .slice()
        .reverse()
        .map((e) => `#${e.id} ${e.createdAt} — ${e.label ?? `${e.authors ?? "someone"}, ${e.changes} change(s)`}`)
        .join("\n");
    },
  },
  {
    name: "board_create",
    description: "Create a new, empty whiteboard; returns its id.",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    run: async ({ title }) => {
      const b = JSON.parse(await api("", { method: "POST", body: JSON.stringify({ title, createdBy: AGENT }) }));
      return `Created board #${b.id} "${b.title}".`;
    },
  },
];

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
        serverInfo: { name: "admin-boards", version: "1.0.0" },
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `unknown tool ${params?.name}`);
      try {
        const text = await tool.run(params.arguments ?? {});
        return reply(id, { content: [{ type: "text", text }] });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
});
