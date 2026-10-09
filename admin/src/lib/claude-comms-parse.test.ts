import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { deriveState, parseTags, splitTaskIds, type CommsMessage } from "./claude-comms-parse";

let n = 0;
const msg = (from: string, to: string, body: string): CommsMessage => {
  n++;
  const at = new Date(Date.UTC(2026, 9, 9, 10, n)).toISOString();
  return { id: `m${n}`, from, to, sentAt: at, receivedAt: at, state: "delivered", summary: null, body, truncated: false, tags: parseTags(body), guess: null };
};
const task = (msgs: CommsMessage[], id: string) => deriveState(msgs).tasks.find((t) => t.id === id);

describe("task parsing, as we write", () => {
  it("a STATUS or DONE with no ACK still counts", () => {
    const a = [msg("alice", "bob", "TASK: T56 What's left"), msg("bob", "alice", "STATUS: T56 half way")];
    assert.equal(task(a, "T56")?.state, "in_progress");
    const b = [msg("alice", "bob", "TASK: T57 Fix it"), msg("bob", "alice", "DONE: T57 pushed abc1234")];
    assert.equal(task(b, "T57")?.state, "done");
  });

  it("several ids in a report's first clause each count", () => {
    for (const body of ["DONE: T53 and T54 (both in agents3d-view.tsx; tsc clean)", "DONE: T53, T54", "DONE: T53 & T54: shipped"]) {
      const m = [msg("alice", "tom", "TASK: T53 One"), msg("alice", "tom", "TASK: T54 Two"), msg("tom", "alice", body)];
      assert.equal(task(m, "T53")?.state, "done", body);
      assert.equal(task(m, "T54")?.state, "done", body);
    }
    const ack = [msg("alice", "tom", "TASK: T53 One"), msg("alice", "tom", "TASK: T54 Two"), msg("tom", "alice", "ACK: T53, T54")];
    assert.deepEqual([task(ack, "T53")?.state, task(ack, "T54")?.state], ["in_progress", "in_progress"]);
    assert.deepEqual(splitTaskIds("T53 and T54 (both done)"), { ids: ["T53", "T54"], rest: "(both done)" });
    // only the first clause: later ids are text
    assert.deepEqual(splitTaskIds("T53 done, T54 next").ids, ["T53"]);
  });

  it("TASK without a colon, at a line start or after a short lead-in; the title is that line's rest", () => {
    assert.deepEqual(parseTags("Queued after T68: TASK T72 Re-test of T69 (7c39383): your bugs.\nMore detail"), [
      { tag: "TASK", arg: "T72 Re-test of T69 (7c39383): your bugs." },
    ]);
    assert.deepEqual(parseTags("TASK T5 Do the thing"), [{ tag: "TASK", arg: "T5 Do the thing" }]);
    assert.deepEqual(parseTags("TASK: T6 Still works"), [{ tag: "TASK", arg: "T6 Still works" }]);
    // the protocol spelled out, a lower-case word, or TASK without an id: not tasks
    assert.deepEqual(parseTags("Write TASK: <id> <title> at line start"), []);
    assert.deepEqual(parseTags("this task T5 is fine"), []);
    assert.deepEqual(parseTags("MULTITASK T5 here"), []);
    const m = [msg("alice", "ramona", "Queued after T68: TASK T72 Re-test of T69\nsteps…"), msg("ramona", "alice", "ACK: T72. I'll start it after T68.")];
    const t = task(m, "T72");
    assert.equal(t?.title, "Re-test of T69");
    assert.equal(t?.state, "in_progress");
    assert.equal(t?.manager, "alice");
  });

  it("an untagged report led by the id, from the worker to the manager, is progress", () => {
    const m = [
      msg("alice", "bob", "TASK: T56 What's left"),
      msg("bob", "tatiana", "T56 is mine; you go first"),
      msg("alice", "bob", "T56 interim: good findings"),
    ];
    assert.equal(task(m, "T56")?.state, "dispatched", "not from the worker to its manager");
    m.push(msg("bob", "alice", "T56 interim (nothing committed yet)"));
    assert.equal(task(m, "T56")?.state, "in_progress");
    // it never closes or reopens one
    const done = [msg("alice", "bob", "TASK: T9 X"), msg("bob", "alice", "DONE: T9"), msg("bob", "alice", "T9 report: more")];
    assert.equal(task(done, "T9")?.state, "done");
  });

  it("T1 doesn't match T12", () => {
    const m = [msg("alice", "bob", "TASK: T1 One"), msg("alice", "bob", "TASK: T12 Twelve"), msg("bob", "alice", "DONE: T12"), msg("bob", "alice", "T12 report")];
    assert.equal(task(m, "T1")?.state, "dispatched");
    assert.equal(task(m, "T12")?.state, "done");
    assert.deepEqual(splitTaskIds("T12 and T1x").ids, ["T12", "T1X"]);
    assert.deepEqual(splitTaskIds("T12x5").ids, []);
  });
});
