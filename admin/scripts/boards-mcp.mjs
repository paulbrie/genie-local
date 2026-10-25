#!/usr/bin/env node
/**
 * MCP server (stdio) that lets a Claude Code session, or any MCP client, take
 * part in the admin's whiteboards: list boards, read one, edit it live (the
 * people on it watch the agent's cursor make the changes) and create boards.
 * A thin client of the HTTP API in src/app/api/boards; no dependencies.
 *
 *   claude mcp add boards \
 *     -e BOARDS_URL=http://127.0.0.1:3002/admin \
 *     -e BOARDS_API_KEY=<the admin's BOARDS_API_KEY> \
 *     -e BOARDS_AGENT=<the name on your cursor> \
 *     -- node /opt/project/admin/scripts/boards-mcp.mjs
 *
 * BOARDS_URL is the admin's own origin + basePath, straight to the app (prod
 * listens on 127.0.0.1:3002; going through nginx works too).
 */
import { createInterface } from "node:readline";

const BASE = (process.env.BOARDS_URL ?? "http://127.0.0.1:3002/admin").replace(/\/$/, "");
const KEY = process.env.BOARDS_API_KEY ?? "";
const AGENT = process.env.BOARDS_AGENT ?? "agent";

async function api(path, init = {}) {
  const res = await fetch(`${BASE}/api/boards${path}`, {
    ...init,
    headers: { "x-api-key": KEY, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 500)}`);
  return text;
}

const OPS_DOC = `Ops, applied in order (all fields optional unless shown):
- {"op":"create","ref":"n1","type":"sticky|text|shape|section|comment","x":0,"y":0,"w":200,"h":200,"text":"…","title":"…(section)","color":"yellow|orange|red|pink|purple|blue|teal|green|gray|white","shape":"rect|roundrect|ellipse|diamond|triangle"}
  "ref" names the new item for later ops in the same call; omit x/y to let the board find free space.
- {"op":"connect","from":"<id or ref>","to":"<id or ref>","label":"…"}
- {"op":"update","id":"<id or ref>", …fields to change}
- {"op":"delete","id":"<id>"}
- {"op":"reply","id":"<comment id>","text":"…"}
Coordinates are board pixels, x right, y down, x/y = top-left. Sections sit behind what they group.`;

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
