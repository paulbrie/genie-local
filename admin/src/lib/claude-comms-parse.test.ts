import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { deriveState, isDefaultName, mergeNodesByName, nameFromPrompt, nodesInWindow, parseTags, recipientName, splitTaskIds, type CommsMessage, type CommsNode } from "./claude-comms-parse";

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
      { tag: "TASK", arg: "T72 Re-test of T69 (7c39383): your bugs.", loose: true },
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

describe("task parsing, the forms that left tasks under To do (T120)", () => {
  it("several ids joined by +, & or and, with a note in brackets after an id", () => {
    const m = [
      msg("alice", "tom", "TASK: T92 (display part) Per-core CPU on the Table"),
      msg("alice", "tom", "TASK: T101 The gauges don't jump"),
      msg("tom", "alice", "DONE: T92 (display part) + T101, in admin-t90, not committed."),
    ];
    assert.deepEqual([task(m, "T92")?.state, task(m, "T101")?.state], ["done", "done"]);
    assert.deepEqual(splitTaskIds("T92 (display part) + T101, in admin-t90").ids, ["T92", "T101"]);
    assert.deepEqual(splitTaskIds("T111 (Table part), in admin-t90").ids, ["T111"]);
    assert.deepEqual(splitTaskIds("T53 and T54 (both in view.tsx)"), { ids: ["T53", "T54"], rest: "(both in view.tsx)" });
  });

  it("an em-dash (or a dash) after the id", () => {
    for (const body of ["DONE: T68 — HEAD 3f58bc8, Bistrița rev 91, 3 seeds × 2 runs", "DONE: T68—report in t68/", "DONE: T68 - all six runs"]) {
      const m = [msg("alice", "ramona", "TASK: T68 Bistrița with repeatable runs"), msg("ramona", "alice", body)];
      assert.equal(task(m, "T68")?.state, "done", body);
    }
  });

  it("a task split between owners is done when its last owner's DONE comes in", () => {
    const m = [
      msg("alice", "alex", "Then TASK: T111 Agents City: a plain question at the end of a turn counts as asking the user"),
      msg("alex", "alice", "DONE: T111 (data part), in admin-t90, not committed."),
      msg("alice", "tom", "TASK: T111 (Table part), extended by the user"),
    ];
    const t = task(m, "T111")!;
    assert.equal(t.state, "in_progress"); // one part done, the other just given
    assert.deepEqual(t.parts, { alex: "done", tom: "dispatched" });
    const done = [...m, msg("tom", "alice", "DONE: T111 (Table part), in admin-t90, not committed.")];
    assert.equal(task(done, "T111")?.state, "done");
    // the parts' own reports: Tom's STATUS on his part doesn't touch Alex's
    const mid = [...m, msg("tom", "alice", "STATUS: T111 wiring the wave")];
    assert.deepEqual(task(mid, "T111")?.parts, { alex: "done", tom: "in_progress" });
  });

  it("a TASK re-sent after DONE doesn't reopen it unless it says resume; then a later DONE closes it again", () => {
    const base = [msg("alice", "tatiana", "TASK: T74 V2 route tracer (from V1)"), msg("tatiana", "alice", "DONE: T74: route tracer checked with the plan's own traffic")];
    assert.equal(task([...base, msg("alice", "tatiana", "TASK: T74 V2 route tracer (from V1)")], "T74")?.state, "done");
    const resumed = [...base, msg("alice", "tatiana", "TASK: T74 resume: the check with the plan's own traffic")];
    assert.equal(task(resumed, "T74")?.state, "dispatched");
    assert.equal(task([...resumed, msg("tatiana", "alice", "DONE: T74: route tracer with screenshots")], "T74")?.state, "done");
    // re-sent while open (a restart's re-send) keeps the work in progress, not back to To do
    const open = [msg("alice", "bob", "TASK: T56 Bistrița after T46"), msg("bob", "alice", "ACK: T56"), msg("alice", "bob", "TASK: T56 Bistrița after T46")];
    assert.equal(task(open, "T56")?.state, "in_progress");
  });

  it("a loose \"TASK T3\" told to someone else doesn't make them an owner", () => {
    const m = [
      msg("alice", "bob", "TASK: T3 The in-app module of the Claude bridge"),
      msg("alice", "alex", "A note for context, no action needed: I've dispatched TASK T3 (the in-app Claude bridge) to Bob."),
      msg("bob", "alice", "ACK: T3"),
      msg("bob", "alice", "DONE: T3 The page side of the bridge, phases 1–3"),
    ];
    assert.equal(task(m, "T3")?.state, "done");
    assert.deepEqual(Object.keys(task(m, "T3")?.parts ?? {}), ["bob"]);
  });

  it("the manager's COMMIT to an owner closes that owner's part only", () => {
    const m = [
      msg("alice", "alex", "TASK: T90 first after the restart (with Tom)"),
      msg("alice", "tom", "TASK: T90 with Alex: your T82–T87 Table work goes onto origin/main"),
      msg("tom", "alice", "STATUS: T90 file list sent to Alex"),
      msg("alex", "alice", "DONE: T90. The Table work is on origin/main in a clean worktree"),
      msg("alice", "alex", "COMMIT: ca7e185 / PUSHED: ca7e185 (T90) on origin/main"),
    ];
    assert.deepEqual(task(m, "T90")?.parts, { alex: "done", tom: "in_progress" });
    const told = [...m, msg("alice", "tom", "COMMIT: ca7e185 / PUSHED (T90): your T82–T87 Table work is on origin/main.")];
    assert.equal(task(told, "T90")?.state, "done");
    // a commit of one part, to its owner, leaves the other part open
    const split = [
      msg("alice", "alex", "TASK: T92 (data part) Per-core CPU"),
      msg("alice", "tom", "TASK: T92 (display part) Per-core CPU on the Table"),
      msg("tom", "alice", "ACK: T92"),
      msg("alex", "alice", "DONE: T92 (data part), in admin-t90"),
      msg("alice", "alex", "COMMIT: 3d03d75 / PUSHED (T92 data part) on origin/main"),
    ];
    assert.deepEqual(task(split, "T92")?.parts, { alex: "done", tom: "in_progress" });
  });

  it("a BLOCKED followed by the manager's COMMIT / PUSHED of that id means done", () => {
    const m = [
      msg("alice", "alex", "Then TASK: T110 genie: document the 2xlarge size"),
      msg("alex", "alice", "BLOCKED: T110 commit/push. This session's permission check denied the amend and the push"),
      msg("alice", "alex", "COMMIT: a4414f6 / PUSHED (T110) to genie's main: I amended 8b3f2e8"),
    ];
    assert.equal(task(m, "T110")?.state, "done");
    // not from someone else, and not for an open (unblocked) task
    const other = [m[0], m[1], msg("tom", "alex", "COMMIT: a4414f6 (T110)")];
    assert.equal(task(other, "T110")?.state, "blocked");
    // an open task the manager commits for its owner is done too
    const open = [m[0], msg("alex", "alice", "ACK: T110"), msg("alice", "alex", "COMMIT: a4414f6 / PUSHED (T110) to genie's main")];
    assert.equal(task(open, "T110")?.state, "done");
    // but not before it was taken up
    assert.equal(task([m[0], m[2]], "T110")?.state, "dispatched");
  });

  it("an untagged \"T85 ready\" is left unread (it never closes a task)", () => {
    const m = [msg("alice", "alex", "TASK: T85 Agents City CPU"), msg("alex", "alice", "ACK: T85"), msg("alex", "alice", "T85 ready")];
    assert.equal(task(m, "T85")?.state, "in_progress");
  });
});

const node = (sid: string, name: string, o: Partial<CommsNode> = {}): CommsNode => ({
  key: `s:${sid}`, sessionId: sid, shortId: sid.slice(0, 8), name, names: [{ name, at: null }], cwd: "/opt/project/projects/trafficsim",
  gitBranch: null, live: false, status: null, tmux: null, sockets: [], role: "peer", sent: 0, received: 0,
  lastActivity: null, sessions: [sid], guest: false, asking: null, ...o,
});

describe("one agent per name", () => {
  const oldBob = node("b0000001-old", "Bob", { sent: 5, received: 3, lastActivity: "2026-10-09T20:13:00Z", sockets: ["uds:/a.sock"] });
  const newBob = node("b0000002-new", "Bob", { live: true, status: "busy", tmux: "admin-Bob", sent: 1, lastActivity: "2026-10-09T20:56:00Z", sockets: ["uds:/b.sock"] });

  it("sessions with the same name merge; the live one is shown and keeps its key", () => {
    const { nodes, keyOf } = mergeNodesByName([oldBob, newBob, node("a0000001", "Alice", { live: true })]);
    assert.equal(nodes.length, 2);
    const bob = nodes.find((n) => n.name === "Bob")!;
    assert.equal(bob.key, newBob.key);
    assert.deepEqual([bob.live, bob.status, bob.tmux], [true, "busy", "admin-Bob"]);
    assert.deepEqual(bob.sessions, ["b0000002-new", "b0000001-old"]);
    assert.deepEqual([bob.sent, bob.received, bob.lastActivity], [6, 3, "2026-10-09T20:56:00Z"]);
    assert.deepEqual(bob.sockets, ["uds:/b.sock", "uds:/a.sock"]);
    assert.equal(keyOf.get(oldBob.key), newBob.key);
  });

  it("with none live, the latest active one is shown (an ended agent is still one agent)", () => {
    const later = { ...newBob, live: false, status: null };
    const { nodes } = mergeNodesByName([later, oldBob]);
    assert.deepEqual(nodes.map((n) => n.key), [newBob.key]);
    const flipped = mergeNodesByName([{ ...oldBob, live: true }, later]).nodes;
    assert.equal(flipped[0].key, oldBob.key, "live beats more recent");
  });

  it("unchosen names (ids, pids) never merge; dir-based defaults are guests", () => {
    const a = node("46012075-aaaa", "46012075");
    const x: CommsNode = { ...node("x", "pid 99"), key: "x:uds:/99.sock", sessionId: null, shortId: "pid 99", sessions: [] };
    const { nodes } = mergeNodesByName([a, x, { ...x, key: "x:uds:/99b.sock" }]);
    assert.equal(nodes.length, 3);
    assert.ok(nodes.every((n) => n.guest));
    assert.ok(isDefaultName("project-f7", "/opt/project", "96ee253c-1"));
    assert.ok(!isDefaultName("project-f7", "/opt/project/admin", "96ee253c-1"));
    assert.ok(!isDefaultName("Bob", "/opt/project", "96ee253c-1"));
    const guest = mergeNodesByName([node("c1", "project-f7", { cwd: "/opt/project" })]).nodes[0];
    assert.equal(guest.guest, true);
  });

  it("after the merge, a restarted worker's reports land on the task it had before", () => {
    const m = [
      msg("s:alice", oldBob.key, "TASK: T56 What's left"),
      msg(oldBob.key, "s:alice", "ACK: T56"),
      msg(newBob.key, "s:alice", "STATUS: T56 back after the restart"),
    ];
    const { keyOf } = mergeNodesByName([oldBob, newBob]);
    for (const x of m) [x.from, x.to] = [keyOf.get(x.from) ?? x.from, keyOf.get(x.to) ?? x.to];
    const ts = deriveState(m).tasks.filter((t) => t.id === "T56");
    assert.equal(ts.length, 1);
    assert.equal(ts[0].worker, newBob.key);
    assert.equal(ts[0].history.length, 3);
  });
});

describe("which reports change a task (T56, T74)", () => {
  it("a part's DONE (T44.7) is progress on T44 and never closes another open task", () => {
    const m = [
      msg("alice", "bob", "TASK: T44 Test in Sketch fixes"),
      msg("alice", "bob", "TASK: T46 Zone locks"),
      msg("alice", "bob", "TASK: T56 What's left"),
      msg("bob", "alice", "ACK: T56"),
      // Bob's 20:13 message, as sent
      msg("bob", "alice", "DONE: T46 the lane and junction zone locks\nCOMMIT: 657bb2d\nDONE: T44.7 RoadStats.lanes (per road)\nCOMMIT: 72b001e\nSTATUS: T56 parts 1, 3, 4 are done"),
    ];
    assert.equal(task(m, "T46")?.state, "done");
    assert.equal(task(m, "T56")?.state, "in_progress");
    assert.equal(task(m, "T44")?.state, "in_progress");
    assert.equal(task(m, "T44")?.lastText, "T44.7 RoadStats.lanes (per road)");
    assert.equal(task(m, "T44.7"), undefined);
    assert.deepEqual(splitTaskIds("T44.7 RoadStats").ids, ["T44.7"]);
  });

  it("only an id right after DONE: closes a task; an id-less DONE changes nothing", () => {
    const m = [msg("alice", "bob", "TASK: T56 What's left"), msg("bob", "alice", "ACK: T56"), msg("bob", "alice", "DONE: the harness part, see above")];
    assert.equal(task(m, "T56")?.state, "in_progress");
    const s = [msg("alice", "bob", "TASK: T57 X"), msg("bob", "alice", "STATUS: half way")];
    assert.equal(task(s, "T57")?.state, "in_progress", "an id-less STATUS still counts");
  });

  it("DONE / ACK from someone else than the owner or the manager leaves the state alone", () => {
    const m = [
      msg("alice", "tatiana", "TASK: T74 V2 route tracer"),
      msg("tatiana", "alice", "ACK: T74"),
      msg("bob", "alice", "DONE: T74 sim part (test cars, for Tatiana)\nCOMMIT: 46a9565"),
    ];
    const t = task(m, "T74")!;
    assert.equal(t.state, "in_progress");
    assert.equal(t.worker, "tatiana");
    assert.equal(t.history.length, 2, "the original task is kept, not replaced by Bob's report");
    assert.equal(deriveState(m).tasks.filter((x) => x.id === "T74").length, 1);
    const ack = [msg("alice", "tatiana", "TASK: T75 Y"), msg("bob", "alice", "ACK: T75")];
    assert.equal(task(ack, "T75")?.state, "dispatched");
    // the manager can still close it
    m.push(msg("alice", "tatiana", "DONE: T74 accepted"));
    assert.equal(task(m, "T74")?.state, "done");
  });
});

describe("names for sessions that ended before a reboot (T121)", () => {
  it("the team's first prompt names a session; other openings don't", () => {
    assert.equal(nameFromPrompt("You are Bob, simulation and editor, in a team of Claude Code sessions managed by Alice.\nRead …"), "Bob");
    assert.equal(nameFromPrompt("  You are Alice, the manager of the team in /opt/project/projects/trafficsim/docs/team.md."), "Alice");
    assert.equal(nameFromPrompt("You are Tom. Read team.md."), "Tom");
    for (const t of ["You are a helpful assistant.", "you are Bob, lower case", "You are Claude, made by Anthropic.", "Fix the build please", "You are Bobby the tester who"])
      assert.equal(nameFromPrompt(t), null, t);
  });

  it("a SendMessage result names the socket it reached", () => {
    assert.equal(recipientName("“ACK T92” → Alice (another Claude session on this machine; queued there — …)"), "Alice");
    assert.equal(recipientName("“x” → Bob [351878] (another Claude session on this machine; …)"), "Bob");
    assert.equal(recipientName("“x” → uds:/run/user/1000/cc-socks/14604.sock (another Claude session …)"), null);
    assert.equal(recipientName("queued"), null);
  });

  it("only nodes with something in the window are listed: a pre-reboot socket with old messages only isn't", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 9, 10, h)).toISOString();
    const pid = { ...node("x", "pid 14604"), key: "x:uds:/run/user/1000/cc-socks/14604.sock", sessionId: null, sessions: [], guest: true };
    const bob = node("b1", "Bob", { live: true });
    const tom = node("t1", "Tom");
    const old = { ...msg("s:a1", pid.key, "TASK: T56 What's left"), sentAt: at(0) };
    const recent = { ...msg(tom.key, "s:a1", "STATUS: T96"), sentAt: at(13) };
    const tasks = deriveState([old]).tasks;
    const listed = nodesInWindow([pid, bob, tom], [recent], tasks, at(6));
    assert.deepEqual(listed.map((n) => n.name), ["Bob", "Tom"]);
    // with its task updated inside the window, its owner stays
    const t2 = tasks.map((t) => ({ ...t, updatedAt: at(13) }));
    assert.deepEqual(nodesInWindow([pid, bob, tom], [], t2, at(6)).map((n) => n.name), ["pid 14604", "Bob"]);
  });
});
