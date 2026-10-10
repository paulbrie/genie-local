import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { CommsMessage, CommsTask } from "./claude-comms-parse";
import { board, elapsed, fmtSpan, latestStatus, threadOf, type BoardModel } from "./task-board";

const at = (min: number) => new Date(Date.UTC(2026, 9, 9, 10, min)).toISOString();
const msg = (id: string, min: number, body: string, tags: CommsMessage["tags"] = []): CommsMessage => ({
  id, from: "s:alice", to: "s:bob", sentAt: at(min), receivedAt: at(min), state: "delivered", summary: null, body, truncated: false, tags, guess: null,
});
const task = (over: Partial<CommsTask>): CommsTask => ({
  key: over.id ?? "k", id: "T1", title: "A task", manager: "s:alice", worker: "s:bob", state: "dispatched", guessed: false,
  lastText: null, createdAt: at(0), updatedAt: at(0), history: [], ...over,
});

const t1 = task({
  id: "T1", state: "done", updatedAt: at(50),
  history: [
    { state: "dispatched", at: at(0), msgId: "m1", text: null },
    { state: "in_progress", at: at(5), msgId: "m2", text: "taken" },
    { state: "in_progress", at: at(20), msgId: "m3", text: "half way\nmore" },
    { state: "done", at: at(47), msgId: "m4", text: "pushed abc1234" },
  ],
});
const t2 = task({ id: "T2", title: "Other", worker: "s:tom", state: "in_progress", updatedAt: at(30), history: [{ state: "in_progress", at: at(10), msgId: "m5", text: "on it" }] });
const t3 = task({ id: "T3", state: "done", updatedAt: at(60), history: [{ state: "done", at: at(60), msgId: "m6", text: null }] });
const messages = [
  msg("m1", 0, "TASK: T1 A task", [{ tag: "TASK", arg: "T1 A task" }]),
  msg("m2", 5, "ACK: T1 taken", [{ tag: "ACK", arg: "T1 taken" }]),
  msg("m3", 20, "STATUS: T1 half way\nmore", [{ tag: "STATUS", arg: "T1 half way\nmore" }]),
  msg("m4", 47, "DONE: T1 pushed abc1234", [{ tag: "DONE", arg: "T1 pushed abc1234" }]),
  msg("m7", 49, "T1 accepted, thanks"),
  msg("m8", 49, "T12 is something else"),
];
const model: BoardModel = {
  nodes: [
    { key: "s:bob", name: "Bob" } as BoardModel["nodes"][number],
    { key: "s:tom", name: "Tom" } as BoardModel["nodes"][number],
  ],
  messages,
  tasks: [t1, t2, t3],
  files: [{ path: "src/a.ts", holder: null, since: null, guessed: false, history: [{ action: "claim", node: "s:bob", at: at(6), msgId: "x", guessed: false }, { action: "claim", node: "s:bob", at: at(55), msgId: "y", guessed: false }] }],
  commits: [{ hash: "abc1234", abbrev: "abc1234", subject: null, author: null, date: null, remotes: null, project: null, app: null, repo: null, verified: false, pushedTag: true, mentions: [{ hash: "abc1234", kind: "pushed", node: "s:bob", msgId: "m4", at: at(47) }] }],
  projects: { "s:bob": { id: "/opt/project/projects/trafficsim", name: "trafficsim" }, "s:tom": { id: "/opt/project/admin", name: "admin" } },
};

describe("task board", () => {
  it("columns, filters and Done newest first", () => {
    const b = board(model, { project: null, owner: null, search: "" });
    assert.deepEqual(b.done.map((t) => t.id), ["T3", "T1"]);
    assert.deepEqual(b.doing.map((t) => t.id), ["T2"]);
    assert.deepEqual(board(model, { project: "/opt/project/admin", owner: null, search: "" }).doing.map((t) => t.id), ["T2"]);
    assert.deepEqual(board(model, { project: "/opt/project/admin", owner: null, search: "" }).done, []);
    assert.deepEqual(board(model, { project: null, owner: "s:bob", search: "" }).doing, []);
    assert.deepEqual(board(model, { project: null, owner: null, search: "other" }).doing.map((t) => t.id), ["T2"]);
    assert.deepEqual(board(model, { project: null, owner: null, search: "t3" }).done.map((t) => t.id), ["T3"]);
  });

  it("timings: Doing since the ACK, Done took from the ACK", () => {
    assert.equal(elapsed(t1, Date.parse(at(59))), "took 42 min");
    assert.equal(elapsed(t2, Date.parse(at(55))), "for 45 min");
    assert.equal(fmtSpan(125 * 60_000), "2 h 05 min");
    assert.equal(fmtSpan(50 * 3600_000), "2 d 2 h");
  });

  it("latest STATUS line", () => {
    assert.equal(latestStatus(t1, new Map(messages.map((m) => [m.id, m]))), "half way");
    assert.equal(latestStatus(t2, new Map(messages.map((m) => [m.id, m]))), null);
  });

  it("thread: its messages and mentions (not T12), commits, claims while open", () => {
    const th = threadOf(t1, model, Date.parse(at(70)));
    assert.deepEqual(th.messages.map((m) => m.id), ["m1", "m2", "m3", "m4", "m7"]);
    assert.deepEqual(th.commits.map((c) => c.hash), ["abc1234"]);
    assert.deepEqual(th.claims.map((c) => c.at), [at(6)]);
  });
});
