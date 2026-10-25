"use client";

import { Subject } from "subjecto";

import { BASE_PATH } from "@/lib/config";
import {
  applyOps,
  attachedConnectors,
  emptyDoc,
  type Author,
  type BoardDoc,
  type BoardObject,
  type ObjectFields,
  type Op,
} from "@/lib/boards/core.mjs";

export type Peer = {
  pid: string;
  user: Author;
  kind: "human" | "claude" | "agent";
  cursor: { x: number; y: number } | null;
  selection: string[];
  viewport?: { x: number; y: number; w: number; h: number } | null;
  editing?: string | null;
  status?: "idle" | "thinking" | "editing";
};

export type Reaction = { key: string; emoji: string; at: { x: number; y: number }; user: Author };

export type SyncStatus = "connecting" | "live" | "offline" | "missing" | "closed";

type Snapshot = Map<string, BoardObject | null>;
type UndoEntry = { before: Snapshot; after: Snapshot };

/** A run of edits that undoes as one step (a drag, a typing session). */
export type Gesture = {
  apply(ops: Op[]): void;
  end(): void;
};

let opCounter = 0;

/** What the hub sends (server/boards.mjs). */
type ServerMsg =
  | { t: "init"; seq: number; title: string; doc: BoardDoc; you: string; peers: Peer[]; claude?: { busy: boolean } }
  | { t: "ops"; seq: number; opId?: string; actor: Author; at: number; ops: Op[] }
  | { t: "presence"; peer: Peer }
  | { t: "leave"; pid: string }
  | { t: "title"; title: string }
  | { t: "claude"; busy: boolean }
  | { t: "reaction"; pid: string; user: Author; at: { x: number; y: number }; emoji: string };

/**
 * One open board: the socket to the hub, the confirmed doc (the hub's), our
 * not-yet-acked ops on top of it (the doc the UI shows), presence of the
 * others, and per-person undo/redo.
 */
export class BoardSync {
  readonly doc = new Subject<BoardDoc>(emptyDoc(), { name: "board.doc" });
  readonly peers = new Subject<Record<string, Peer>>({}, { name: "board.peers" });
  readonly status = new Subject<SyncStatus>("connecting", { name: "board.status" });
  readonly title = new Subject<string>("", { name: "board.title" });
  readonly claudeBusy = new Subject<boolean>(false, { name: "board.claudeBusy" });
  readonly reactions = new Subject<Reaction[]>([], { name: "board.reactions" });
  readonly canUndo = new Subject<boolean>(false);
  readonly canRedo = new Subject<boolean>(false);
  /** Server clock minus ours, from the hub's timestamps (for the shared timer). */
  serverOffset = 0;
  serverNow() {
    return Date.now() + this.serverOffset;
  }
  you = "";

  private ws: WebSocket | null = null;
  private confirmed: BoardDoc = emptyDoc();
  private pending: { opId: string; ops: Op[] }[] = [];
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private presenceQueued: Record<string, unknown> | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private flushQueued = false;

  constructor(
    readonly boardId: number,
    public user: Author,
  ) {}

  connect() {
    this.stopped = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}${BASE_PATH}/boards-ws?board=${this.boardId}`);
    this.ws = ws;
    this.status.next("connecting");
    ws.onopen = () => ws.send(JSON.stringify({ t: "hello", user: this.user }));
    ws.onmessage = (e) => this.onMessage(JSON.parse(String(e.data)));
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (e.code === 4404) return this.status.next("missing");
      if (e.code === 4410) return this.status.next("closed");
      if (this.stopped) return;
      this.status.next("offline");
      this.peers.next({});
      const wait = Math.min(10_000, 500 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => this.connect(), wait);
    };
  }

  close() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
  }

  /** Changed our name or colour: say hello again. */
  setUser(user: Author) {
    this.user = user;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "hello", user }));
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(msg: ServerMsg) {
    switch (msg.t) {
      case "init": {
        this.retry = 0;
        this.confirmed = msg.doc;
        this.you = msg.you;
        this.title.next(msg.title);
        this.claudeBusy.next(!!msg.claude?.busy);
        const peers: Record<string, Peer> = {};
        for (const p of msg.peers) peers[p.pid] = p;
        this.peers.next(peers);
        // Whatever we sent and never heard back about goes again (votes excepted:
        // they aren't idempotent, and losing one beats counting it twice).
        const resend = this.pending
          .map((p) => ({ ...p, ops: p.ops.filter((o) => o.k !== "vote") }))
          .filter((p) => p.ops.length);
        this.pending = resend;
        for (const p of resend) this.send({ t: "op", opId: p.opId, ops: p.ops });
        // Publish now (not next frame) so whoever reacts to "live" sees the doc.
        this.doc.next(this.withPending());
        this.status.next("live");
        break;
      }
      case "ops": {
        this.serverOffset = msg.at - Date.now();
        this.confirmed = applyOps(this.confirmed, msg.ops, msg.actor, msg.at);
        if (msg.opId) {
          const at = this.pending.findIndex((p) => p.opId === msg.opId);
          if (at >= 0) this.pending.splice(at, 1);
        }
        this.recompute();
        break;
      }
      case "presence": {
        const peer = msg.peer;
        if (peer.pid === this.you) break;
        this.peers.next({ ...this.peers.getValue(), [peer.pid]: peer });
        break;
      }
      case "leave": {
        const rest = { ...this.peers.getValue() };
        delete rest[msg.pid];
        this.peers.next(rest);
        break;
      }
      case "title":
        this.title.next(msg.title);
        break;
      case "claude":
        this.claudeBusy.next(!!msg.busy);
        break;
      case "reaction": {
        const r: Reaction = { key: `${msg.pid}-${Date.now()}-${Math.random()}`, emoji: msg.emoji, at: msg.at, user: msg.user };
        this.reactions.next([...this.reactions.getValue(), r].slice(-40));
        setTimeout(() => this.reactions.next(this.reactions.getValue().filter((x) => x.key !== r.key)), 2200);
        break;
      }
    }
  }

  /** Local doc = confirmed + our pending ops, published once per frame. */
  private recompute() {
    if (this.flushQueued) return;
    this.flushQueued = true;
    requestAnimationFrame(() => {
      this.flushQueued = false;
      this.doc.next(this.withPending());
    });
  }

  private withPending() {
    let d = this.confirmed;
    for (const p of this.pending) d = applyOps(d, p.ops, this.user, Date.now());
    return d;
  }

  /** Send ops (no undo entry). Applied locally right away. */
  private push(ops: Op[]) {
    if (!ops.length) return;
    const opId = `${this.user.id.slice(0, 8)}-${Date.now().toString(36)}-${++opCounter}`;
    this.pending.push({ opId, ops });
    // Apply to what's on screen now, not a frame later, so a gesture's next
    // step reads its own last step.
    this.doc.next(applyOps(this.doc.getValue(), ops, this.user, Date.now()));
    this.send({ t: "op", opId, ops });
  }

  /** Edits that undo as one step. */
  gesture(): Gesture {
    const before: Snapshot = new Map();
    return {
      apply: (ops) => {
        const doc = this.doc.getValue();
        for (const id of touchedIds(doc, ops)) {
          if (!before.has(id)) before.set(id, doc.objects[id] ?? null);
        }
        this.push(ops);
      },
      end: () => {
        if (!before.size) return;
        const doc = this.doc.getValue();
        const after: Snapshot = new Map();
        for (const id of before.keys()) after.set(id, doc.objects[id] ?? null);
        if ([...before].every(([id, o]) => o === after.get(id))) return;
        this.undoStack.push({ before, after });
        if (this.undoStack.length > 200) this.undoStack.shift();
        this.redoStack = [];
        this.canUndo.next(true);
        this.canRedo.next(false);
      },
    };
  }

  /** One undoable edit. */
  apply(ops: Op[]) {
    const g = this.gesture();
    g.apply(ops);
    g.end();
  }

  /** Ops that aren't undoable (votes, chat, replies, board settings). */
  send1(ops: Op[]) {
    this.push(ops);
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    this.push(restoreOps(this.doc.getValue(), e.before, e.after));
    this.redoStack.push(e);
    this.canUndo.next(this.undoStack.length > 0);
    this.canRedo.next(true);
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    this.push(restoreOps(this.doc.getValue(), e.after, e.before));
    this.undoStack.push(e);
    this.canUndo.next(true);
    this.canRedo.next(this.redoStack.length > 0);
  }

  /** Cursor, selection, viewport, editing: sent at most every 40 ms. */
  presence(p: {
    cursor?: { x: number; y: number } | null;
    selection?: string[];
    viewport?: { x: number; y: number; w: number; h: number };
    editing?: string | null;
  }) {
    this.presenceQueued = { ...(this.presenceQueued ?? {}), ...p };
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      const q = this.presenceQueued;
      this.presenceQueued = null;
      if (q) this.send({ t: "presence", ...q });
    }, 40);
  }

  askClaude(text: string, selection: string[], viewport: { x: number; y: number; w: number; h: number }) {
    this.send({ t: "claude", text, selection, viewport });
  }

  react(emoji: string, at: { x: number; y: number }) {
    this.send({ t: "reaction", emoji, at });
    this.onMessage({ t: "reaction", pid: "me", emoji, at, user: this.user });
  }
}

/** Ids an op batch changes, including connectors a delete takes with it. */
function touchedIds(doc: BoardDoc, ops: Op[]): string[] {
  const ids: string[] = [];
  for (const op of ops) {
    if (op.k === "put") ids.push(op.obj.id);
    else if (op.k === "patch") ids.push(op.id);
    else if (op.k === "del") ids.push(op.id, ...attachedConnectors(doc, [op.id]));
  }
  return ids;
}

/**
 * Ops that bring each object in `snap` back to that state. Only the fields that
 * differ between `snap` and `other` (the far side of the same undo step, i.e.
 * what this person changed) are restored, so undoing your move doesn't also
 * revert the text someone else typed into the sticky since.
 */
function restoreOps(doc: BoardDoc, snap: Snapshot, other: Snapshot): Op[] {
  const ops: Op[] = [];
  // Deletes last, puts first: a restored connector needs its ends to exist.
  const dels: Op[] = [];
  for (const [id, want] of snap) {
    const now = doc.objects[id];
    if (want === now) continue;
    if (!want) {
      if (now) dels.push({ k: "del", id });
    } else if (now) {
      // Votes aren't part of anyone's undo; a flag the old state lacked
      // (suggestion, dashed) is cleared with null, which survives JSON.
      const far = other.get(id) as Record<string, unknown> | null | undefined;
      const mine = want as unknown as Record<string, unknown>;
      const fields: Record<string, unknown> = {};
      for (const k of new Set([...Object.keys(mine), ...Object.keys(far ?? {})])) {
        if (k === "id" || k === "type" || k === "votes") continue;
        if (far && JSON.stringify(mine[k]) === JSON.stringify(far[k])) continue;
        fields[k] = k in mine ? mine[k] : null;
      }
      if (Object.keys(fields).length) ops.push({ k: "patch", id, set: fields as ObjectFields });
    } else {
      ops.push({ k: "put", obj: want });
    }
  }
  ops.sort((a, b) => (a.k === "put" && b.k === "put" ? Number(a.obj.type === "connector") - Number(b.obj.type === "connector") : 0));
  return [...ops, ...dels];
}
