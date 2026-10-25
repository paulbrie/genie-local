/**
 * The board hub: real-time collaboration for /boards, hosted in the custom
 * server next to the PTY bridge (see server.mjs).
 *
 * Each open board is a room holding the authoritative doc. Browsers connect to
 * `<basePath>/boards-ws?board=<id>` (cookie-checked in server.mjs), say hello
 * with their display name, get the doc, then send ops. The hub applies each
 * batch with `applyOps` (src/lib/boards/core.mjs), numbers it and broadcasts the
 * batch as applied to everyone, the sender included (its ack); clients re-apply
 * their still-unacked ops on top, so everyone converges on the hub's order.
 * Presence (cursor, selection, viewport) is relayed but never stored.
 *
 * Claude takes part three ways: asked in the Claude panel, @mentioned in a
 * comment, or as the facilitator that chimes in after the group goes quiet.
 * Outside agents edit through the HTTP API (src/app/api/boards), which reaches
 * this hub through `globalThis.__boardsHub` since Next runs in this process.
 * Claude and agents get a cursor that moves to what they touch.
 *
 * Docs are saved to Postgres (`boards.doc`) a moment after each change, on the
 * last disconnect and on SIGTERM.
 */
import pg from "pg";

import {
  applyOps,
  CLAUDE_COLOR,
  CLAUDE_ID,
  isId,
  newId,
  normalizeDoc,
  opFocus,
  PARTICIPANT_COLORS,
  translateAgentOps,
} from "../src/lib/boards/core.mjs";
import {
  askPrompt,
  claudeBusy,
  commentPrompt,
  extractJson,
  facilitatorPrompt,
  runClaudeCli,
} from "./boards-claude.mjs";

const SAVE_DEBOUNCE_MS = 1200;
const EVICT_AFTER_MS = 2 * 60_000;
const MAX_OPS_PER_BATCH = 500;
const AGENT_PRESENCE_MS = 20_000;
// Facilitator: speak after this much quiet, at most this often, and only once
// enough happened since its last look.
const QUIET_MS = 45_000;
const FACILITATOR_EVERY_MS = 4 * 60_000;
const FACILITATOR_MIN_EDITS = 5;

const CLAUDE = { id: CLAUDE_ID, name: "Claude", color: CLAUDE_COLOR };

let pool;
function db() {
  // Lazy: server.mjs loads .env.local after this module is imported.
  pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  return pool;
}

/** @type {Map<number, Room>} */
const rooms = new Map();
/** @type {Map<number, Promise<Room|null>>} */
const loading = new Map();

class Room {
  constructor(id, title, doc) {
    this.id = id;
    this.title = title;
    this.doc = doc;
    this.seq = 0;
    /** @type {Set<Client>} */
    this.clients = new Set();
    /** Non-socket participants (Claude, API agents) by presence id. */
    this.bots = new Map();
    this.dirty = false;
    this.saveTimer = null;
    this.evictTimer = null;
    this.lastHumanEditAt = 0;
    this.editsSinceFacilitator = 0;
    this.recentlyEdited = [];
    this.lastFacilitatorAt = Date.now();
    this.claudeRuns = 0;
    /** API agents mid-playback; like Claude runs, they keep the room loaded. */
    this.holds = 0;
  }

  humans() {
    const seen = new Map();
    for (const c of this.clients) if (c.user) seen.set(c.user.id, c.user.name);
    return [...seen.values()];
  }

  send(client, msg) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
  }

  broadcast(msg, except) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c !== except && c.user && c.ws.readyState === 1) c.ws.send(data);
    }
  }

  /** Apply a batch as `actor`, broadcast it, schedule a save. Returns the ops applied. */
  apply(actor, ops, { opId, human = false } = {}) {
    const now = Date.now();
    const next = applyOps(this.doc, ops, actor, now);
    this.seq++;
    this.doc = next;
    this.broadcast({ t: "ops", seq: this.seq, opId, actor, at: now, ops });
    if (human) {
      this.lastHumanEditAt = now;
      this.editsSinceFacilitator += ops.length;
      for (const op of ops) {
        const id = op.id ?? op.obj?.id;
        if (id) this.recentlyEdited = [id, ...this.recentlyEdited.filter((x) => x !== id)].slice(0, 30);
      }
    }
    this.scheduleSave();
    return ops;
  }

  scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((e) => console.error(`[boards] save ${this.id}:`, e.message));
    }, SAVE_DEBOUNCE_MS);
  }

  async save() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await db().query("update boards set doc = $2, updated_at = now() where id = $1", [this.id, this.doc]);
    } catch (e) {
      this.dirty = true;
      throw e;
    }
  }

  peers() {
    const list = [];
    for (const c of this.clients) if (c.user) list.push(c.presence());
    for (const b of this.bots.values()) list.push(b.peer);
    return list;
  }

  /** Show / move a bot participant (Claude, an agent). */
  botPresence(user, kind, patch, ttlMs) {
    const pid = `bot:${user.id}`;
    let bot = this.bots.get(pid);
    if (!bot) {
      bot = { peer: { pid, user, kind, cursor: null, selection: [], status: "idle" }, timer: null };
      this.bots.set(pid, bot);
    }
    Object.assign(bot.peer, patch);
    this.broadcast({ t: "presence", peer: bot.peer });
    clearTimeout(bot.timer);
    bot.timer = ttlMs
      ? setTimeout(() => {
          this.bots.delete(pid);
          this.broadcast({ t: "leave", pid });
        }, ttlMs)
      : null;
  }

  /** Apply agent ops one at a time, moving the author's cursor to each. */
  async playback(user, kind, ops, { ttlMs = AGENT_PRESENCE_MS } = {}) {
    const delay = Math.max(60, Math.min(320, 6000 / Math.max(1, ops.length)));
    for (const op of ops) {
      if (!rooms.has(this.id)) break;
      const focus = opFocus(this.doc, op);
      if (focus) {
        this.botPresence(user, kind, { cursor: focus, status: "editing" }, ttlMs);
        await sleep(delay);
      }
      this.apply(user, [op]);
      const id = op.k === "put" ? op.obj.id : op.id;
      if (id && op.k !== "del") this.botPresence(user, kind, { selection: [id] }, ttlMs);
    }
    this.botPresence(user, kind, { selection: [], status: "idle" }, ttlMs);
  }

  touch() {
    clearTimeout(this.evictTimer);
    this.evictTimer = null;
  }

  maybeEvict() {
    if (this.clients.size || this.claudeRuns || this.holds) return;
    clearTimeout(this.evictTimer);
    this.save().catch((e) => console.error(`[boards] save ${this.id}:`, e.message));
    this.evictTimer = setTimeout(async () => {
      if (this.clients.size || this.claudeRuns || this.holds) return;
      try {
        await this.save();
      } catch {
        return; // keep it in memory and retry on the next disconnect
      }
      rooms.delete(this.id);
    }, EVICT_AFTER_MS);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadRoom(id) {
  const open = rooms.get(id);
  if (open) return open;
  if (!loading.has(id)) {
    loading.set(
      id,
      db()
        .query("select title, doc from boards where id = $1 and archived_at is null", [id])
        .then(({ rows }) => {
          if (!rows[0]) return null;
          const room = new Room(id, rows[0].title, normalizeDoc(rows[0].doc));
          rooms.set(id, room);
          return room;
        })
        .finally(() => loading.delete(id)),
    );
  }
  return loading.get(id);
}

// ------------------------------------------------------------------ clients

let cidCounter = 0;

class Client {
  constructor(ws) {
    this.ws = ws;
    this.cid = `c${++cidCounter}`;
    this.user = null;
    this.cursor = null;
    this.selection = [];
    this.viewport = null;
    this.editing = null;
  }
  presence() {
    return {
      pid: this.cid,
      user: this.user,
      kind: "human",
      cursor: this.cursor,
      selection: this.selection,
      viewport: this.viewport,
      editing: this.editing,
    };
  }
}

function cleanUser(u) {
  if (!u || typeof u !== "object" || !isId(u.id) || u.id === CLAUDE_ID || u.id.startsWith("agent-")) return null;
  const name = typeof u.name === "string" ? u.name.trim().slice(0, 40) : "";
  if (!name) return null;
  const color = /^#[0-9a-f]{6}$/i.test(u.color) ? u.color : PARTICIPANT_COLORS[0];
  return { id: u.id, name, color };
}

function finitePoint(p) {
  if (!p || typeof p !== "object") return null;
  const x = Number(p.x);
  const y = Number(p.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}
function finiteRect(v) {
  const p = finitePoint(v);
  const w = Number(v?.w);
  const h = Number(v?.h);
  return p && Number.isFinite(w) && Number.isFinite(h) ? { ...p, w, h } : null;
}

/** Ops from a browser: known kinds only; chat is always the sender's own words. */
function cleanClientOps(room, ops, user) {
  if (!Array.isArray(ops)) return [];
  const out = [];
  for (const op of ops.slice(0, MAX_OPS_PER_BATCH)) {
    if (!op || typeof op !== "object") continue;
    switch (op.k) {
      case "put":
        if (!op.obj || !isId(op.obj.id)) break;
        // A new object is authored by whoever made it; a restore (undo) keeps its author.
        out.push(room.doc.objects[op.obj.id] || op.obj.author ? op : { ...op, obj: { ...op.obj, author: user } });
        break;
      case "patch":
      case "del":
      case "vote":
      case "reply":
      case "clearVotes":
      case "meta":
        out.push(op);
        break;
      case "chat":
        if (op.msg && isId(op.msg.id)) out.push({ k: "chat", msg: { id: op.msg.id, text: op.msg.text, role: "user", author: user } });
        break;
    }
  }
  return out;
}

const MENTION = /(^|\W)@claude\b/i;

/** Comments in this batch where a person just @mentioned Claude. */
function mentionedComments(room, ops) {
  const ids = [];
  for (const op of ops) {
    if (op.k === "reply" && MENTION.test(op.msg?.text ?? "")) ids.push(op.id);
    if (op.k === "put" && op.obj?.type === "comment" && !op.obj.thread?.some((m) => m.author?.id === CLAUDE_ID)) {
      const last = op.obj.thread?.at(-1);
      if (last && MENTION.test(last.text ?? "") && op.obj.thread.length === 1) ids.push(op.obj.id);
    }
  }
  return ids.filter((id) => room.doc.objects[id]?.type === "comment");
}

export async function handleBoardConnection(ws, boardId) {
  const client = new Client(ws);
  let room = null;

  const alive = setInterval(() => {
    if (ws.readyState === 1) ws.ping();
  }, 30_000);

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.t === "hello") {
      const user = cleanUser(msg.user);
      if (!user) return ws.close(4400, "bad hello");
      room = await loadRoom(boardId).catch(() => null);
      if (!room) return ws.close(4404, "no such board");
      room.touch();
      client.user = user;
      room.clients.add(client);
      room.send(client, {
        t: "init",
        seq: room.seq,
        title: room.title,
        doc: room.doc,
        you: client.cid,
        peers: room.peers().filter((p) => p.pid !== client.cid),
        claude: { busy: room.claudeRuns > 0 },
      });
      room.broadcast({ t: "presence", peer: client.presence() }, client);
      return;
    }
    if (!room || !client.user) return;

    switch (msg.t) {
      case "op": {
        const ops = cleanClientOps(room, msg.ops, client.user);
        room.apply(client.user, ops, { opId: msg.opId, human: true });
        for (const id of mentionedComments(room, ops)) runCommentMention(room, id);
        break;
      }
      case "presence": {
        if ("cursor" in msg) client.cursor = finitePoint(msg.cursor);
        if (Array.isArray(msg.selection)) client.selection = msg.selection.filter(isId).slice(0, 200);
        if ("viewport" in msg) client.viewport = finiteRect(msg.viewport);
        if ("editing" in msg) client.editing = isId(msg.editing) ? msg.editing : null;
        room.broadcast({ t: "presence", peer: client.presence() }, client);
        break;
      }
      case "claude": {
        const text = typeof msg.text === "string" ? msg.text.trim().slice(0, 4000) : "";
        if (text) runAsk(room, client, text, msg.selection, msg.viewport);
        break;
      }
      case "reaction": {
        // Ephemeral emoji bursts: relayed, never stored.
        const p = finitePoint(msg.at);
        if (p && typeof msg.emoji === "string" && msg.emoji.length <= 8) {
          room.broadcast({ t: "reaction", pid: client.cid, user: client.user, at: p, emoji: msg.emoji });
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    clearInterval(alive);
    if (!room) return;
    room.clients.delete(client);
    room.broadcast({ t: "leave", pid: client.cid });
    room.maybeEvict();
  });
  ws.on("error", () => {});
}

// ------------------------------------------------------------------ Claude

function claudeChat(room, id, text, pending = false) {
  room.apply(CLAUDE, [{ k: "chat", msg: { id, text, role: "claude", author: CLAUDE, pending } }]);
}

function parseAnswer(raw) {
  const j = extractJson(raw);
  return {
    reply: typeof j.reply === "string" ? j.reply.trim() : "",
    ops: Array.isArray(j.ops) ? j.ops : [],
  };
}

async function withClaude(room, cursorNear, fn) {
  room.claudeRuns++;
  room.broadcast({ t: "claude", busy: true });
  room.botPresence(CLAUDE, "claude", { cursor: cursorNear, status: "thinking" }, 0);
  try {
    return await fn();
  } finally {
    room.claudeRuns--;
    room.broadcast({ t: "claude", busy: room.claudeRuns > 0 });
    room.botPresence(CLAUDE, "claude", { status: "idle" }, 15_000);
    room.maybeEvict();
  }
}

function centre(vp) {
  return vp ? { x: vp.x + vp.w / 2, y: vp.y + vp.h / 2 } : null;
}

async function runAsk(room, client, text, selection, viewport) {
  const asker = client.user;
  room.apply(asker, [{ k: "chat", msg: { id: newId("m"), text, role: "user", author: asker } }], { human: true });
  const replyId = newId("m");
  if (room.claudeRuns || claudeBusy()) {
    claudeChat(room, replyId, "I'm still working on something else; ask me again in a moment.");
    return;
  }
  const vp = finiteRect(viewport);
  claudeChat(room, replyId, "Thinking…", true);
  await withClaude(room, centre(vp), async () => {
    try {
      const prompt = askPrompt({
        doc: room.doc,
        title: room.title,
        people: room.humans(),
        asker: asker.name,
        text,
        selection: Array.isArray(selection) ? selection.filter((id) => isId(id) && room.doc.objects[id]) : [],
        viewport: vp,
      });
      const answer = parseAnswer(await runClaudeCli(prompt));
      const { ops, errors } = translateAgentOps(room.doc, answer.ops, CLAUDE, Date.now());
      if (errors.length) console.warn(`[boards] claude op errors on ${room.id}:`, errors.slice(0, 5));
      claudeChat(room, replyId, answer.reply || (ops.length ? "Done." : "Hmm, nothing to change there."), ops.length > 0);
      await room.playback(CLAUDE, "claude", ops, { ttlMs: 0 });
      if (ops.length) claudeChat(room, replyId, answer.reply || "Done.");
    } catch (e) {
      console.error(`[boards] claude ask on ${room.id}:`, e.message);
      claudeChat(room, replyId, `Sorry, that didn't work (${e.message.slice(0, 120)}).`);
    }
  });
}

async function runCommentMention(room, commentId) {
  if (room.claudeRuns || claudeBusy()) {
    room.apply(CLAUDE, [{ k: "reply", id: commentId, msg: { id: newId("m"), text: "I'm busy with another request; mention me again in a moment." } }]);
    return;
  }
  const comment = room.doc.objects[commentId];
  await withClaude(room, { x: comment.x, y: comment.y }, async () => {
    try {
      const answer = parseAnswer(
        await runClaudeCli(commentPrompt({ doc: room.doc, title: room.title, people: room.humans(), comment })),
      );
      const { ops } = translateAgentOps(room.doc, answer.ops, CLAUDE, Date.now());
      if (answer.reply && room.doc.objects[commentId]) {
        room.apply(CLAUDE, [{ k: "reply", id: commentId, msg: { id: newId("m"), text: answer.reply } }]);
      }
      await room.playback(CLAUDE, "claude", ops, { ttlMs: 0 });
    } catch (e) {
      console.error(`[boards] claude mention on ${room.id}:`, e.message);
      if (room.doc.objects[commentId]) {
        room.apply(CLAUDE, [{ k: "reply", id: commentId, msg: { id: newId("m"), text: "Sorry, I couldn't answer that just now." } }]);
      }
    }
  });
}

async function runFacilitator(room) {
  room.lastFacilitatorAt = Date.now();
  room.editsSinceFacilitator = 0;
  const recent = room.recentlyEdited.filter((id) => room.doc.objects[id]).slice(0, 15);
  await withClaude(room, null, async () => {
    try {
      const answer = parseAnswer(
        await runClaudeCli(facilitatorPrompt({ doc: room.doc, title: room.title, people: room.humans(), recent })),
      );
      // The facilitator only adds, and only stickies and comments, as suggestions.
      const creates = answer.ops
        .filter((o) => o && o.op === "create" && (o.type === "sticky" || o.type === "comment"))
        .slice(0, 3);
      const { ops } = translateAgentOps(room.doc, creates, CLAUDE, Date.now());
      for (const op of ops) if (op.k === "put") op.obj.suggestion = true;
      if (answer.reply) claudeChat(room, newId("m"), answer.reply);
      await room.playback(CLAUDE, "claude", ops, { ttlMs: 0 });
    } catch (e) {
      console.error(`[boards] facilitator on ${room.id}:`, e.message);
    }
  });
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (
      room.doc.meta.facilitator &&
      room.clients.size > 0 &&
      !room.claudeRuns &&
      !claudeBusy() &&
      room.editsSinceFacilitator >= FACILITATOR_MIN_EDITS &&
      now - room.lastHumanEditAt >= QUIET_MS &&
      now - room.lastFacilitatorAt >= FACILITATOR_EVERY_MS
    ) {
      runFacilitator(room);
    }
  }
}, 5000).unref();

// ------------------------------------------------------------------ agents (HTTP API)

function agentUser(name) {
  const clean = String(name ?? "agent").trim().slice(0, 40) || "agent";
  const slug = clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "agent";
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { id: `agent-${slug}`, name: clean, color: PARTICIPANT_COLORS[h % PARTICIPANT_COLORS.length] };
}

const hub = {
  /** The live doc when the board is open, else null (read it from the DB). */
  liveDoc(id) {
    return rooms.get(id)?.doc ?? null;
  },
  participants(id) {
    return rooms.get(id)?.peers().map((p) => ({ name: p.user.name, kind: p.kind })) ?? [];
  },
  /** Agent ops through the HTTP API, played back live with the agent's cursor. */
  async applyAgentOps(id, agentName, agentOps, { chat } = {}) {
    const room = await loadRoom(id);
    if (!room) return null;
    room.touch();
    room.holds++;
    try {
      const user = agentUser(agentName);
      const { ops, created, errors } = translateAgentOps(room.doc, agentOps, user, Date.now());
      if (typeof chat === "string" && chat.trim()) {
        room.apply(user, [{ k: "chat", msg: { id: newId("m"), text: chat.trim().slice(0, 4000), role: "user", author: user } }]);
      }
      await room.playback(user, "agent", ops);
      return { applied: ops.length, created, errors, doc: room.doc };
    } finally {
      room.holds--;
      room.maybeEvict();
    }
  },
  renamed(id, title) {
    const room = rooms.get(id);
    if (!room) return;
    room.title = title;
    room.broadcast({ t: "title", title });
  },
  /** Being archived: save it, then close every socket on it. */
  async closed(id) {
    const room = rooms.get(id);
    if (!room) return;
    rooms.delete(id);
    clearTimeout(room.saveTimer);
    await room.save().catch((e) => console.error(`[boards] save ${id}:`, e.message));
    for (const c of room.clients) c.ws.close(4410, "board closed");
  },
  /** Replace a board's doc wholesale (restore from JSON); everyone reloads it. */
  async replaceDoc(id, doc) {
    const room = await loadRoom(id);
    if (!room) return false;
    room.doc = normalizeDoc(doc);
    room.seq++;
    for (const c of room.clients) room.send(c, { t: "init", seq: room.seq, title: room.title, doc: room.doc, you: c.cid, peers: room.peers().filter((p) => p.pid !== c.cid), claude: { busy: room.claudeRuns > 0 } });
    room.scheduleSave();
    room.maybeEvict();
    return true;
  },
};
globalThis.__boardsHub = hub;

/** Save every dirty board (SIGTERM). */
export async function flushBoards() {
  await Promise.allSettled([...rooms.values()].map((r) => r.save()));
}
