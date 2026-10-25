/**
 * Boards: the shared document model of a whiteboard and the one function that
 * changes it. Plain ESM with no dependencies, because two very different
 * runtimes import it and must agree to the byte:
 *
 *  - the board hub in the custom server (`server/boards.mjs`, raw Node, no
 *    Next compile), which owns the authoritative copy of every open board,
 *    orders everyone's edits and saves them;
 *  - the browser canvas (`src/components/boards`), which applies its own edits
 *    optimistically and re-applies them on top of what the hub sends back.
 *
 * A board is `{ v, objects: { [id]: obj }, meta, chat }`. Edits are small ops
 * (put / patch / del / vote / reply / meta / chat); a patch sets whole fields,
 * so two people editing different fields of a sticky both win, and the same
 * field is last-writer-wins in the hub's order (Figma's model, not a CRDT).
 * `applyOps` is pure: it returns a new doc and keeps every untouched object's
 * identity, so React can skip re-rendering them.
 *
 * Types live in core.d.mts.
 */

export const DOC_VERSION = 1;

export const LIMITS = {
  objects: 5000,
  text: 10_000,
  title: 200,
  penPoints: 4000,
  thread: 200,
  chat: 200,
  cell: 2000,
  cols: 20,
  rows: 200,
  coord: 1_000_000,
  size: 100_000,
  votesPerUser: 10,
};

/** Sticky / fill palette, by name (agents and Claude use the names). */
export const COLORS = {
  yellow: "#fde68a",
  orange: "#fdba74",
  red: "#fca5a5",
  pink: "#f9a8d4",
  purple: "#c4b5fd",
  blue: "#93c5fd",
  teal: "#5eead4",
  green: "#86efac",
  gray: "#d4d4d8",
  white: "#ffffff",
};

/** Ink colours for text, shape strokes, connectors and the pen. */
export const INKS = {
  black: "#18181b",
  gray: "#71717a",
  red: "#dc2626",
  orange: "#ea580c",
  green: "#16a34a",
  blue: "#2563eb",
  purple: "#7c3aed",
  pink: "#db2777",
};

/** Cursor colours handed to participants (Claude is always CLAUDE_COLOR). */
export const PARTICIPANT_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];
export const CLAUDE_ID = "claude";
export const CLAUDE_COLOR = "#d97757";

export const OBJECT_TYPES = [
  "sticky",
  "text",
  "shape",
  "section",
  "connector",
  "pen",
  "image",
  "comment",
  "link",
  "table",
];
export const SHAPES = ["rect", "roundrect", "ellipse", "diamond", "triangle"];
export const ARROWS = ["end", "both", "none"];
/** Where a line meets a shape: a named side, or "auto" to follow the other end. */
export const SIDES = ["auto", "top", "right", "bottom", "left"];

/** Where uploaded board images are served from (relative to the basePath). */
export const ASSET_PREFIX = "/api/boards/assets/";

export const DEFAULT_SIZES = {
  sticky: { w: 200, h: 200 },
  text: { w: 240, h: 48 },
  shape: { w: 200, h: 120 },
  section: { w: 640, h: 420 },
  image: { w: 320, h: 240 },
  comment: { w: 32, h: 32 },
  link: { w: 340, h: 104 },
  table: { w: 480, h: 132 },
};

/** A table's cells: the first row is its header. Ragged input is squared off. */
function sanitizeRows(raw) {
  const rows = (Array.isArray(raw) ? raw : []).slice(0, LIMITS.rows).map((r) => (Array.isArray(r) ? r : [r]));
  if (!rows.length) return [["", "", ""], ["", "", ""]];
  const cols = Math.min(LIMITS.cols, Math.max(1, ...rows.map((r) => r.length)));
  return rows.map((r) => Array.from({ length: cols }, (_, c) => str(r[c] ?? "", LIMITS.cell)));
}

/** A link's address, or null for anything that isn't a plain http(s) one. */
function sanitizeUrl(v) {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.href.slice(0, 2000) : null;
  } catch {
    return null;
  }
}

export function emptyDoc() {
  return {
    v: DOC_VERSION,
    objects: {},
    meta: { timer: null, voting: null, facilitator: false },
    chat: [],
  };
}

/** A stored doc (jsonb) back into shape; tolerant of old or partial rows. */
export function normalizeDoc(raw) {
  const doc = emptyDoc();
  if (!raw || typeof raw !== "object") return doc;
  const objects = raw.objects && typeof raw.objects === "object" ? raw.objects : {};
  for (const [id, o] of Object.entries(objects)) {
    const clean = sanitizeObject({ ...o, id });
    if (clean) doc.objects[id] = clean;
  }
  if (raw.meta && typeof raw.meta === "object") doc.meta = sanitizeMeta({ ...doc.meta, ...raw.meta });
  if (Array.isArray(raw.chat)) {
    doc.chat = raw.chat.map(sanitizeChat).filter(Boolean).slice(-LIMITS.chat);
  }
  return doc;
}

// ---------------------------------------------------------------- validation

const ID_RE = /^[\w-]{1,64}$/;
const COLOR_RE = /^(#[0-9a-f]{3,8}|transparent)$/i;

function num(v, lo, hi, dflt) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}
function str(v, max, dflt = "") {
  return typeof v === "string" ? v.slice(0, max) : dflt;
}
function color(v, dflt) {
  if (typeof v !== "string") return dflt;
  if (COLOR_RE.test(v)) return v.toLowerCase();
  const named = COLORS[v.toLowerCase()] ?? INKS[v.toLowerCase()];
  return named ?? dflt;
}
function oneOf(v, list, dflt) {
  return list.includes(v) ? v : dflt;
}
export function isId(v) {
  return typeof v === "string" && ID_RE.test(v);
}

function sanitizeAuthor(a) {
  if (!a || typeof a !== "object" || !isId(a.id)) return undefined;
  return {
    id: a.id,
    name: str(a.name, 60, "Someone") || "Someone",
    color: color(a.color, "#71717a"),
  };
}

function sanitizeEnd(e) {
  if (!e || typeof e !== "object") return null;
  const out = {
    x: num(e.x, -LIMITS.coord, LIMITS.coord, 0),
    y: num(e.y, -LIMITS.coord, LIMITS.coord, 0),
  };
  if (isId(e.id)) out.id = e.id;
  const side = oneOf(e.side, SIDES, "auto");
  if (side !== "auto") out.side = side;
  return out;
}

function sanitizeVotes(v) {
  const out = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, n] of Object.entries(v)) {
    const c = Math.round(num(n, 0, LIMITS.votesPerUser, 0));
    if (isId(k) && c > 0) out[k] = c;
  }
  return out;
}

function sanitizeMessage(m) {
  if (!m || typeof m !== "object" || !isId(m.id)) return null;
  const text = str(m.text, LIMITS.text).trim();
  if (!text) return null;
  return {
    id: m.id,
    author: sanitizeAuthor(m.author) ?? { id: "unknown", name: "Someone", color: "#71717a" },
    text,
    at: num(m.at, 0, 1e15, 0),
  };
}

function sanitizeChat(m) {
  const msg = sanitizeMessage(m);
  if (!msg) return null;
  msg.role = m.role === "claude" ? "claude" : "user";
  if (m.pending === true) msg.pending = true;
  return msg;
}

/** A board object with only known fields, clamped; null if unusable. */
export function sanitizeObject(o) {
  if (!o || typeof o !== "object" || !isId(o.id)) return null;
  const type = oneOf(o.type, OBJECT_TYPES, null);
  if (!type) return null;
  const size = DEFAULT_SIZES[type] ?? { w: 1, h: 1 };
  const out = {
    id: o.id,
    type,
    x: num(o.x, -LIMITS.coord, LIMITS.coord, 0),
    y: num(o.y, -LIMITS.coord, LIMITS.coord, 0),
    w: num(o.w, 1, LIMITS.size, size.w),
    h: num(o.h, 1, LIMITS.size, size.h),
    z: num(o.z, -1e9, 1e9, 0),
  };
  const author = sanitizeAuthor(o.author);
  if (author) out.author = author;
  out.createdAt = num(o.createdAt, 0, 1e15, 0);
  if (o.suggestion === true) out.suggestion = true;
  const votes = sanitizeVotes(o.votes);
  if (Object.keys(votes).length) out.votes = votes;

  switch (type) {
    case "sticky":
      out.text = str(o.text, LIMITS.text);
      out.color = color(o.color, COLORS.yellow);
      break;
    case "text":
      out.text = str(o.text, LIMITS.text);
      out.color = color(o.color, INKS.black);
      out.fontSize = num(o.fontSize, 8, 200, 20);
      break;
    case "shape":
      out.shape = oneOf(o.shape, SHAPES, "rect");
      out.text = str(o.text, LIMITS.text);
      out.color = color(o.color, COLORS.blue);
      out.stroke = color(o.stroke, INKS.black);
      break;
    case "section":
      out.title = str(o.title, LIMITS.title, "Section");
      out.color = color(o.color, "#f4f4f5");
      out.fontSize = num(o.fontSize, 8, 200, 13);
      // Folded: the frame shows as a bar and what's inside it is hidden.
      if (o.collapsed === true) out.collapsed = true;
      break;
    case "connector": {
      out.from = sanitizeEnd(o.from) ?? { x: out.x, y: out.y };
      out.to = sanitizeEnd(o.to) ?? { x: out.x + 100, y: out.y };
      out.label = str(o.label, LIMITS.title);
      out.arrow = oneOf(o.arrow, ARROWS, "end");
      out.color = color(o.color, INKS.black);
      if (o.dashed === true) out.dashed = true;
      if (o.curved === true) out.curved = true;
      break;
    }
    case "pen": {
      const pts = Array.isArray(o.points) ? o.points.slice(0, LIMITS.penPoints) : [];
      out.points = pts
        .filter((p) => Array.isArray(p) && p.length >= 2)
        .map((p) => [
          Math.round(num(p[0], -LIMITS.size, LIMITS.size, 0) * 10) / 10,
          Math.round(num(p[1], -LIMITS.size, LIMITS.size, 0) * 10) / 10,
        ]);
      if (out.points.length === 0) return null;
      out.color = color(o.color, INKS.black);
      out.width = num(o.width, 1, 40, 3);
      break;
    }
    case "image": {
      const src = str(o.src, 400);
      if (!src.startsWith(ASSET_PREFIX) || src.includes("..")) return null;
      out.src = src;
      out.alt = str(o.alt, LIMITS.title);
      break;
    }
    case "link": {
      const url = sanitizeUrl(o.url);
      if (!url) return null;
      out.url = url;
      out.title = str(o.title, LIMITS.title);
      out.desc = str(o.desc, 400);
      break;
    }
    case "table":
      out.rows = sanitizeRows(o.rows);
      // Fixed first column, for a table read as a list of labelled things.
      if (o.headerCol === true) out.headerCol = true;
      break;
    case "comment":
      out.thread = (Array.isArray(o.thread) ? o.thread : [])
        .map(sanitizeMessage)
        .filter(Boolean)
        .slice(0, LIMITS.thread);
      out.resolved = o.resolved === true;
      out.w = DEFAULT_SIZES.comment.w;
      out.h = DEFAULT_SIZES.comment.h;
      break;
  }
  return out;
}

function sanitizeTimer(t) {
  if (!t || typeof t !== "object") return null;
  const durationMs = num(t.durationMs, 1000, 4 * 3600_000, 300_000);
  const endsAt = t.endsAt == null ? null : num(t.endsAt, 0, 1e15, null);
  const remainingMs = t.remainingMs == null ? null : num(t.remainingMs, 0, durationMs, durationMs);
  return { durationMs, endsAt, remainingMs };
}

function sanitizeVoting(v) {
  if (!v || typeof v !== "object") return null;
  return { maxVotes: Math.round(num(v.maxVotes, 1, LIMITS.votesPerUser, 3)) };
}

export function sanitizeMeta(m) {
  return {
    timer: sanitizeTimer(m?.timer),
    voting: sanitizeVoting(m?.voting),
    facilitator: m?.facilitator === true,
  };
}

// ---------------------------------------------------------------- applying

/** Ids of connectors attached to any of `ids` (deleted along with them). */
export function attachedConnectors(doc, ids) {
  const set = new Set(ids);
  const out = [];
  for (const o of Object.values(doc.objects)) {
    if (o.type === "connector" && ((o.from.id && set.has(o.from.id)) || (o.to.id && set.has(o.to.id)))) {
      out.push(o.id);
    }
  }
  return out;
}

export function maxZ(doc) {
  let z = 0;
  for (const o of Object.values(doc.objects)) if (o.z > z) z = o.z;
  return z;
}
export function minZ(doc) {
  let z = 0;
  for (const o of Object.values(doc.objects)) if (o.z < z) z = o.z;
  return z;
}

function votesUsed(doc, userId) {
  let n = 0;
  for (const o of Object.values(doc.objects)) n += o.votes?.[userId] ?? 0;
  return n;
}

/**
 * Apply `ops` by `actor` ({ id, name, color }) at `now` (ms). Pure: returns a
 * new doc (or the same one when nothing changed). Ops that don't apply — an
 * edit to an object someone just deleted, a vote over the limit — are skipped,
 * never thrown, so the hub and every client stay in step.
 */
export function applyOps(doc, ops, actor, now) {
  let objects = doc.objects;
  let meta = doc.meta;
  let chat = doc.chat;
  let objCopied = false;
  const own = () => {
    if (!objCopied) {
      objects = { ...objects };
      objCopied = true;
    }
  };
  const author = sanitizeAuthor(actor);
  const working = () => ({ ...doc, objects, meta, chat });

  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op !== "object") continue;
    switch (op.k) {
      case "put": {
        const prev = op.obj && objects[op.obj.id];
        if (!prev && Object.keys(objects).length >= LIMITS.objects) break;
        const clean = sanitizeObject({
          author,
          createdAt: now,
          ...op.obj,
        });
        if (!clean) break;
        own();
        objects[clean.id] = clean;
        break;
      }
      case "patch": {
        const prev = objects[op.id];
        if (!prev || !op.set || typeof op.set !== "object") break;
        const clean = sanitizeObject({ ...prev, ...op.set, id: prev.id, type: prev.type });
        if (!clean) break;
        own();
        objects[prev.id] = clean;
        break;
      }
      case "del": {
        if (!objects[op.id]) break;
        own();
        const gone = [op.id, ...attachedConnectors({ objects }, [op.id])];
        for (const id of gone) delete objects[id];
        break;
      }
      case "vote": {
        const prev = objects[op.id];
        if (!prev || !author || prev.type === "connector" || prev.type === "comment") break;
        const delta = op.delta > 0 ? 1 : -1;
        const mine = prev.votes?.[author.id] ?? 0;
        if (delta < 0 && mine === 0) break;
        const max = meta.voting?.maxVotes ?? LIMITS.votesPerUser;
        if (delta > 0 && votesUsed(working(), author.id) >= max) break;
        const votes = { ...(prev.votes ?? {}) };
        if (mine + delta > 0) votes[author.id] = mine + delta;
        else delete votes[author.id];
        own();
        objects[prev.id] = { ...prev, votes };
        if (!Object.keys(votes).length) delete objects[prev.id].votes;
        break;
      }
      case "clearVotes": {
        for (const o of Object.values(objects)) {
          if (!o.votes) continue;
          own();
          const rest = { ...o };
          delete rest.votes;
          objects[o.id] = rest;
        }
        break;
      }
      case "reply": {
        const prev = objects[op.id];
        if (!prev || prev.type !== "comment" || prev.thread.length >= LIMITS.thread) break;
        const msg = sanitizeMessage({ ...op.msg, author, at: now });
        if (!msg || prev.thread.some((m) => m.id === msg.id)) break;
        own();
        objects[prev.id] = { ...prev, thread: [...prev.thread, msg], resolved: false };
        break;
      }
      case "meta": {
        if (!op.set || typeof op.set !== "object") break;
        meta = sanitizeMeta({ ...meta, ...op.set });
        break;
      }
      case "chat": {
        const msg = sanitizeChat({ ...op.msg, author: op.msg?.author ?? author, at: now });
        if (!msg) break;
        const at = chat.findIndex((m) => m.id === msg.id);
        chat = at >= 0 ? chat.map((m, i) => (i === at ? msg : m)) : [...chat, msg].slice(-LIMITS.chat);
        break;
      }
    }
  }
  if (objects === doc.objects && meta === doc.meta && chat === doc.chat) return doc;
  return { ...doc, objects, meta, chat };
}

// ---------------------------------------------------------------- agent ops

let idCounter = 0;
/** A short random id, unique enough per board (both sides use it). */
export function newId(prefix = "o") {
  idCounter = (idCounter + 1) % 1296;
  const rand = Math.random().toString(36).slice(2, 9);
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

/** Bounding box of every object (connectors excluded); null on an empty board. */
export function contentBounds(doc, filter) {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const o of Object.values(doc.objects)) {
    if (o.type === "connector" || (filter && !filter(o))) continue;
    x1 = Math.min(x1, o.x);
    y1 = Math.min(y1, o.y);
    x2 = Math.max(x2, o.x + o.w);
    y2 = Math.max(y2, o.y + o.h);
  }
  return x1 === Infinity ? null : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function overlaps(doc, r, pad) {
  for (const o of Object.values(doc.objects)) {
    if (o.type === "connector" || o.type === "section" || o.type === "comment") continue;
    if (
      r.x < o.x + o.w + pad &&
      r.x + r.w + pad > o.x &&
      r.y < o.y + o.h + pad &&
      r.y + r.h + pad > o.y
    ) {
      return true;
    }
  }
  return false;
}

/** A free spot for a w×h object, scanning outward from `near` (or right of the content). */
export function findFreeSpot(doc, w, h, near) {
  const b = contentBounds(doc);
  const origin = near ?? (b ? { x: b.x + b.w + 80, y: b.y } : { x: 0, y: 0 });
  const step = 40;
  for (let ring = 0; ring < 40; ring++) {
    for (let dy = 0; dy <= ring; dy++) {
      for (const [ix, iy] of [
        [ring, dy],
        [dy, ring],
      ]) {
        const r = { x: origin.x + ix * step, y: origin.y + iy * step, w, h };
        if (!overlaps(doc, r, 16)) return { x: r.x, y: r.y };
      }
    }
  }
  return { x: origin.x, y: origin.y };
}

const AGENT_FIELDS = ["x", "y", "w", "h", "text", "title", "color", "shape", "label", "fontSize", "arrow", "stroke", "collapsed", "curved", "url", "desc", "rows", "headerCol"];

/**
 * The small, forgiving op language Claude and outside agents write
 * (`create` / `update` / `delete` / `reply` / `connect`), turned into real ops
 * for `applyOps`. A created object may carry a `ref` that later ops in the same
 * batch use instead of its id. Unknown ids are dropped, missing positions are
 * filled with free space. Returns { ops, created: { ref: id }, errors, doc }.
 */
export function translateAgentOps(doc, agentOps, actor, now) {
  const ops = [];
  const created = {};
  const errors = [];
  let work = doc;
  let z = maxZ(doc);
  const resolve = (ref) => {
    if (typeof ref !== "string") return null;
    if (created[ref]) return created[ref];
    return work.objects[ref] ? ref : null;
  };
  const push = (op) => {
    ops.push(op);
    work = applyOps(work, [op], actor, now);
  };

  (Array.isArray(agentOps) ? agentOps : []).slice(0, 200).forEach((a, i) => {
    if (!a || typeof a !== "object") return;
    const kind = a.op ?? a.k ?? a.action;
    if (kind === "create" || kind === "connect") {
      const type = kind === "connect" ? "connector" : a.type;
      if (!OBJECT_TYPES.includes(type) || type === "pen" || type === "image") {
        errors.push(`#${i}: can't create type ${JSON.stringify(type)}`);
        return;
      }
      const id = newId(type[0]);
      const obj = { id, type, z: type === "section" ? minZ(work) - 1 : ++z };
      for (const f of AGENT_FIELDS) if (a[f] !== undefined) obj[f] = a[f];
      if (type === "connector") {
        const from = resolve(a.from);
        const to = resolve(a.to);
        if (!from || !to) {
          errors.push(`#${i}: connector needs from/to ids that exist`);
          return;
        }
        obj.from = { id: from, x: 0, y: 0, side: a.fromSide };
        obj.to = { id: to, x: 0, y: 0, side: a.toSide };
        if (a.text && !a.label) obj.label = a.text;
      } else if (type === "comment") {
        const text = str(a.text, LIMITS.text).trim();
        if (!text) {
          errors.push(`#${i}: comment needs text`);
          return;
        }
        obj.thread = [{ id: newId("m"), author: actor, text, at: now }];
        delete obj.text;
      }
      if (type !== "connector") {
        const size = DEFAULT_SIZES[type];
        obj.w = num(obj.w, 1, LIMITS.size, size.w);
        obj.h = num(obj.h, 1, LIMITS.size, size.h);
        if (obj.x === undefined || obj.y === undefined) {
          const spot = findFreeSpot(work, obj.w, obj.h, obj.x !== undefined || obj.y !== undefined ? { x: obj.x ?? 0, y: obj.y ?? 0 } : undefined);
          obj.x = spot.x;
          obj.y = spot.y;
        }
      }
      push({ k: "put", obj });
      if (typeof a.ref === "string" && a.ref) created[a.ref] = id;
      return;
    }
    if (kind === "update" || kind === "move") {
      const id = resolve(a.id);
      if (!id) {
        errors.push(`#${i}: no object ${JSON.stringify(a.id)}`);
        return;
      }
      const set = {};
      for (const f of AGENT_FIELDS) if (a[f] !== undefined) set[f] = a[f];
      if (a.resolved !== undefined) set.resolved = a.resolved === true;
      if (Object.keys(set).length) push({ k: "patch", id, set });
      return;
    }
    if (kind === "arrange" || kind === "fit") {
      const id = resolve(a.id);
      if (!id || work.objects[id].type !== "section") {
        errors.push(`#${i}: ${kind} needs a section id`);
        return;
      }
      for (const op of kind === "arrange" ? arrangeSectionOps(work, id) : fitSectionOps(work, id)) push(op);
      return;
    }
    if (kind === "delete") {
      const id = resolve(a.id);
      if (id) push({ k: "del", id });
      else errors.push(`#${i}: no object ${JSON.stringify(a.id)}`);
      return;
    }
    if (kind === "reply") {
      const id = resolve(a.id);
      if (!id || work.objects[id].type !== "comment") {
        errors.push(`#${i}: reply needs a comment id`);
        return;
      }
      push({ k: "reply", id, msg: { id: newId("m"), text: a.text } });
      return;
    }
    errors.push(`#${i}: unknown op ${JSON.stringify(kind)}`);
  });
  return { ops, created, errors, doc: work };
}

/** Where an op happens on the board, for animating its author's cursor. */
export function opFocus(doc, op) {
  const o = op.k === "put" ? op.obj : doc.objects[op.id];
  if (!o) return null;
  if (o.type === "connector") {
    const a = o.from.id ? doc.objects[o.from.id] : null;
    const b = o.to.id ? doc.objects[o.to.id] : null;
    if (a && b) return { x: (a.x + a.w / 2 + b.x + b.w / 2) / 2, y: (a.y + a.h / 2 + b.y + b.h / 2) / 2 };
    return { x: o.from.x, y: o.from.y };
  }
  const set = op.k === "patch" ? op.set : {};
  const x = num(set.x, -LIMITS.coord, LIMITS.coord, o.x ?? 0);
  const y = num(set.y, -LIMITS.coord, LIMITS.coord, o.y ?? 0);
  return { x: x + (o.w ?? 0) / 2, y: y + (o.h ?? 0) / 2 };
}

// ---------------------------------------------------------------- describing

const NAME_OF = Object.fromEntries(
  [...Object.entries(INKS), ...Object.entries(COLORS)].map(([n, hex]) => [hex, n]),
);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const r = (n) => Math.round(n);

/** The smallest section whose box holds the object's centre. */
function sectionOf(doc, o) {
  if (o.type === "section" || o.type === "connector") return null;
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  let best = null;
  for (const s of Object.values(doc.objects)) {
    if (s.type !== "section" || s.id === o.id) continue;
    if (cx >= s.x && cx <= s.x + s.w && cy >= s.y && cy <= s.y + s.h) {
      if (!best || s.w * s.h < best.w * best.h) best = s;
    }
  }
  return best?.id ?? null;
}

/**
 * The board as compact JSON lines, one object per line, for Claude's prompt and
 * the agent API: what each thing is, where (x,y top-left, w,h, y grows down),
 * its text, colour name, the section it sits in, votes and comment threads.
 * `only` limits it to some ids (big boards); text is clipped to `maxText`.
 */
export function describeBoard(doc, { only, maxText = 400, names } = {}) {
  const lines = [];
  const list = Object.values(doc.objects)
    .filter((o) => !only || only.has(o.id))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const o of list) {
    const d = { id: o.id, type: o.type };
    if (o.type !== "connector") Object.assign(d, { x: r(o.x), y: r(o.y), w: r(o.w), h: r(o.h) });
    if ("color" in o && o.type !== "pen") d.color = NAME_OF[o.color] ?? o.color;
    switch (o.type) {
      case "sticky":
      case "text":
        d.text = clip(o.text, maxText);
        break;
      case "shape":
        d.shape = o.shape;
        if (o.text) d.text = clip(o.text, maxText);
        break;
      case "section":
        d.title = o.title;
        d.fontSize = o.fontSize;
        if (o.collapsed) d.collapsed = true;
        break;
      case "connector":
        d.from = o.from.id ?? `(${r(o.from.x)},${r(o.from.y)})`;
        d.to = o.to.id ?? `(${r(o.to.x)},${r(o.to.y)})`;
        if (o.from.side) d.fromSide = o.from.side;
        if (o.to.side) d.toSide = o.to.side;
        if (o.curved) d.curved = true;
        if (o.label) d.label = o.label;
        break;
      case "pen":
        d.note = "freehand drawing";
        break;
      case "image":
        if (o.alt) d.alt = o.alt;
        break;
      case "link":
        d.url = o.url;
        if (o.title) d.title = o.title;
        if (o.desc) d.desc = clip(o.desc, maxText);
        break;
      case "table":
        d.rows = o.rows.map((r) => r.map((cell) => clip(cell, 80)));
        break;
      case "comment":
        d.resolved = o.resolved;
        d.thread = o.thread.map((m) => `${m.author.name}: ${clip(m.text, maxText)}`);
        break;
    }
    const sec = sectionOf(doc, o);
    if (sec) d.in = sec;
    if (o.votes) d.votes = Object.values(o.votes).reduce((a, b) => a + b, 0);
    if (o.suggestion) d.suggestion = true;
    if (names && o.author) d.by = o.author.name;
    lines.push(JSON.stringify(d));
  }
  return lines.join("\n");
}

/**
 * What a collapsed section hides: everything whose middle sits inside it, and
 * the connectors with an end on any of them. Sections don't nest in practice,
 * but one inside another folds away with it.
 */
export function hiddenByCollapsed(doc) {
  const hidden = new Set();
  const folded = Object.values(doc.objects).filter((o) => o.type === "section" && o.collapsed);
  if (!folded.length) return hidden;
  for (const o of Object.values(doc.objects)) {
    if (o.type === "connector") continue;
    const cx = o.x + o.w / 2;
    const cy = o.y + o.h / 2;
    for (const s of folded) {
      if (o.id !== s.id && cx >= s.x && cx <= s.x + s.w && cy >= s.y && cy <= s.y + s.h) {
        hidden.add(o.id);
        break;
      }
    }
  }
  for (const o of Object.values(doc.objects)) {
    if (o.type === "connector" && ((o.from.id && hidden.has(o.from.id)) || (o.to.id && hidden.has(o.to.id)))) {
      hidden.add(o.id);
    }
  }
  return hidden;
}

// ---------------------------------------------------------------- sections

/** What sits in a section: anything (bar connectors) whose middle is inside it. */
export function sectionChildIds(doc, sectionId) {
  const s = doc.objects[sectionId];
  if (!s || s.type !== "section") return [];
  return Object.values(doc.objects)
    .filter((o) => {
      if (o.id === s.id || o.type === "connector") return false;
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      return cx >= s.x && cx <= s.x + s.w && cy >= s.y && cy <= s.y + s.h;
    })
    .map((o) => o.id);
}

const SECTION_PAD = 40;
const SECTION_GAP = 24;

/** Resize a section around what it holds, leaving everything where it is. */
export function fitSectionOps(doc, sectionId, pad = SECTION_PAD) {
  const s = doc.objects[sectionId];
  const kids = sectionChildIds(doc, sectionId).map((id) => doc.objects[id]);
  if (!s || !kids.length) return [];
  const x1 = Math.min(...kids.map((o) => o.x));
  const y1 = Math.min(...kids.map((o) => o.y));
  const x2 = Math.max(...kids.map((o) => o.x + o.w));
  const y2 = Math.max(...kids.map((o) => o.y + o.h));
  return [
    {
      k: "patch",
      id: s.id,
      set: { x: Math.round(x1 - pad), y: Math.round(y1 - pad), w: Math.round(x2 - x1 + pad * 2), h: Math.round(y2 - y1 + pad * 2) },
    },
  ];
}

/**
 * Lay a section's contents out on a grid in reading order and size the section
 * to match. Cells are as big as the largest item so rows and columns line up;
 * the number of columns comes from the section's present width, so a wide frame
 * stays wide. Connectors follow their ends on their own.
 */
export function arrangeSectionOps(doc, sectionId, { gap = SECTION_GAP, pad = SECTION_PAD } = {}) {
  const s = doc.objects[sectionId];
  if (!s) return [];
  const kids = sectionChildIds(doc, sectionId)
    .map((id) => doc.objects[id])
    // Reading order, with a row tolerance so a slightly uneven row stays a row.
    .sort((a, b) => (Math.abs(a.y - b.y) > Math.min(a.h, b.h) / 2 ? a.y - b.y : a.x - b.x));
  if (!kids.length) return [];
  const cellW = Math.max(...kids.map((o) => o.w));
  const cellH = Math.max(...kids.map((o) => o.h));
  const fit = Math.floor((s.w - pad * 2 + gap) / (cellW + gap));
  const cols = Math.max(1, Math.min(kids.length, fit || 1));
  const rows = Math.ceil(kids.length / cols);
  const ops = kids.map((o, i) => ({
    k: "patch",
    id: o.id,
    set: {
      // Each item centred in its cell, so mixed sizes still look tidy.
      x: Math.round(s.x + pad + (i % cols) * (cellW + gap) + (cellW - o.w) / 2),
      y: Math.round(s.y + pad + Math.floor(i / cols) * (cellH + gap) + (cellH - o.h) / 2),
    },
  }));
  ops.push({
    k: "patch",
    id: s.id,
    set: { w: Math.round(pad * 2 + cols * cellW + (cols - 1) * gap), h: Math.round(pad * 2 + rows * cellH + (rows - 1) * gap) },
  });
  return ops;
}
