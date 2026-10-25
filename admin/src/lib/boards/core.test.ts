import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyOps,
  COLORS,
  describeBoard,
  emptyDoc,
  normalizeDoc,
  sanitizeObject,
  translateAgentOps,
  type BoardDoc,
  type Op,
} from "./core.mjs";

const ann = { id: "ann", name: "Ann", color: "#ef4444" };
const bob = { id: "bob", name: "Bob", color: "#3b82f6" };

function board(ops: Op[], actor = ann): BoardDoc {
  return applyOps(emptyDoc(), ops, actor, 1000);
}

const sticky = (id: string, x = 0, y = 0, text = "") =>
  ({ k: "put", obj: { id, type: "sticky", x, y, w: 200, h: 200, z: 1, text } }) as Op;

describe("applyOps", () => {
  it("puts, patches and deletes, stamping author and time on new objects", () => {
    let d = board([sticky("a", 10, 20, "hi")]);
    assert.equal(d.objects.a.type, "sticky");
    assert.deepEqual(d.objects.a.author, ann);
    assert.equal(d.objects.a.createdAt, 1000);
    d = applyOps(d, [{ k: "patch", id: "a", set: { text: "hello", x: 50 } }], bob, 2000);
    assert.equal((d.objects.a as { text: string }).text, "hello");
    assert.equal(d.objects.a.x, 50);
    assert.deepEqual(d.objects.a.author, ann, "a patch doesn't change the author");
    d = applyOps(d, [{ k: "del", id: "a" }], bob, 3000);
    assert.equal(d.objects.a, undefined);
  });

  it("keeps untouched objects identical and returns the same doc for no-ops", () => {
    const d = board([sticky("a"), sticky("b")]);
    const e = applyOps(d, [{ k: "patch", id: "a", set: { x: 5 } }], ann, 1);
    assert.equal(e.objects.b, d.objects.b);
    assert.notEqual(e.objects.a, d.objects.a);
    assert.equal(applyOps(d, [{ k: "patch", id: "gone", set: { x: 1 } }], ann, 1), d);
  });

  it("two people patching different fields both win; the same field goes to the later one", () => {
    let d = board([sticky("a")]);
    d = applyOps(d, [{ k: "patch", id: "a", set: { text: "ann's" } }], ann, 1);
    d = applyOps(d, [{ k: "patch", id: "a", set: { x: 300 } }], bob, 2);
    d = applyOps(d, [{ k: "patch", id: "a", set: { text: "bob's" } }], bob, 3);
    assert.equal(d.objects.a.x, 300);
    assert.equal((d.objects.a as { text: string }).text, "bob's");
  });

  it("deleting an object takes its connectors with it", () => {
    const d = board([
      sticky("a"),
      sticky("b", 400),
      { k: "put", obj: { id: "c", type: "connector", z: 2, from: { id: "a", x: 0, y: 0 }, to: { id: "b", x: 0, y: 0 } } } as Op,
    ]);
    assert.ok(d.objects.c);
    const e = applyOps(d, [{ k: "del", id: "b" }], ann, 1);
    assert.equal(e.objects.c, undefined);
    assert.ok(e.objects.a);
  });

  it("limits votes per person to the session's maximum and takes them back", () => {
    let d = board([sticky("a"), sticky("b"), { k: "meta", set: { voting: { maxVotes: 2 } } }]);
    d = applyOps(d, [{ k: "vote", id: "a", delta: 1 }, { k: "vote", id: "a", delta: 1 }, { k: "vote", id: "b", delta: 1 }], ann, 1);
    assert.deepEqual(d.objects.a.votes, { ann: 2 });
    assert.equal(d.objects.b.votes, undefined, "third vote is over the limit");
    d = applyOps(d, [{ k: "vote", id: "b", delta: 1 }], bob, 1);
    assert.deepEqual(d.objects.b.votes, { bob: 1 });
    d = applyOps(d, [{ k: "vote", id: "a", delta: -1 }, { k: "vote", id: "a", delta: -1 }, { k: "vote", id: "a", delta: -1 }], ann, 1);
    assert.equal(d.objects.a.votes, undefined);
    d = applyOps(d, [{ k: "clearVotes" }], ann, 1);
    assert.equal(d.objects.b.votes, undefined);
  });

  it("appends comment replies once each, by their sender", () => {
    let d = board([{ k: "put", obj: { id: "c", type: "comment", x: 0, y: 0, z: 0, thread: [{ id: "m1", author: ann, text: "Hm?", at: 1 }], resolved: true } } as Op]);
    const reply: Op = { k: "reply", id: "c", msg: { id: "m2", text: "Yes" } };
    d = applyOps(d, [reply, reply], bob, 5);
    const c = d.objects.c as { thread: { author: { id: string }; at: number }[]; resolved: boolean };
    assert.equal(c.thread.length, 2);
    assert.equal(c.thread[1].author.id, "bob");
    assert.equal(c.thread[1].at, 5);
    assert.equal(c.resolved, false, "a reply reopens the thread");
  });

  it("updates a chat message in place by id (Claude's 'thinking…' becomes the answer)", () => {
    let d = board([{ k: "chat", msg: { id: "m", text: "Thinking…", role: "claude", pending: true } }]);
    d = applyOps(d, [{ k: "chat", msg: { id: "m", text: "Done", role: "claude" } }], ann, 2);
    assert.equal(d.chat.length, 1);
    assert.equal(d.chat[0].text, "Done");
    assert.equal(d.chat[0].pending, undefined);
  });

  it("clears an optional flag with null", () => {
    let d = board([{ k: "put", obj: { id: "a", type: "sticky", z: 0, suggestion: true } } as Op]);
    assert.equal(d.objects.a.suggestion, true);
    d = applyOps(d, [{ k: "patch", id: "a", set: { suggestion: null } as never }], ann, 1);
    assert.equal(d.objects.a.suggestion, undefined);
  });
});

describe("sanitizeObject", () => {
  it("drops unknown types and fields, clamps numbers, resolves colour names", () => {
    assert.equal(sanitizeObject({ id: "a", type: "rocket" }), null);
    assert.equal(sanitizeObject({ id: "bad id!", type: "sticky" }), null);
    const o = sanitizeObject({ id: "a", type: "sticky", x: "12", y: Infinity, w: -5, color: "pink", evil: "<script>" }) as Record<string, unknown>;
    assert.equal(o.x, 12);
    assert.equal(o.y, 0);
    assert.equal(o.w, 1);
    assert.equal(o.color, COLORS.pink);
    assert.equal(o.evil, undefined);
  });
  it("only takes images served from the board assets route", () => {
    assert.equal(sanitizeObject({ id: "i", type: "image", src: "https://evil.example/x.png" }), null);
    assert.equal(sanitizeObject({ id: "i", type: "image", src: "/api/boards/assets/../../etc" }), null);
    assert.ok(sanitizeObject({ id: "i", type: "image", src: "/api/boards/assets/1/0123456789abcdef.png" }));
  });
  it("normalizes a stored doc, skipping garbage", () => {
    const d = normalizeDoc({ objects: { a: { type: "sticky", text: "x" }, b: { type: "nope" } }, meta: { facilitator: true }, chat: "no" });
    assert.deepEqual(Object.keys(d.objects), ["a"]);
    assert.equal(d.meta.facilitator, true);
    assert.deepEqual(d.chat, []);
  });
});

describe("translateAgentOps", () => {
  it("creates with refs, connects them, and fills in sizes and free positions", () => {
    const d = board([sticky("old", 0, 0, "existing")]);
    const { ops, created, errors, doc } = translateAgentOps(
      d,
      [
        { op: "create", ref: "q", type: "sticky", text: "Question", color: "blue" },
        { op: "create", ref: "a", type: "shape", shape: "diamond", text: "Answer", x: 600, y: 0 },
        { op: "connect", from: "q", to: "a", label: "leads to" },
        { op: "update", id: "old", text: "edited" },
        { op: "delete", id: "nope" },
      ],
      bob,
      10,
    );
    assert.equal(errors.length, 1, errors.join());
    assert.equal(ops.length, 4);
    const q = doc.objects[created.q];
    assert.equal(q.w, 200);
    assert.ok(q.x >= 200 || q.y >= 200, "placed clear of the existing sticky");
    const conn = Object.values(doc.objects).find((o) => o.type === "connector") as { from: { id: string }; to: { id: string }; label: string };
    assert.equal(conn.from.id, created.q);
    assert.equal(conn.to.id, created.a);
    assert.equal(conn.label, "leads to");
    assert.equal((doc.objects.old as { text: string }).text, "edited");
    assert.equal(doc.objects[created.q].author?.id, "bob");
  });
  it("refuses connectors to things that don't exist and unknown ops", () => {
    const { ops, errors } = translateAgentOps(emptyDoc(), [{ op: "connect", from: "x", to: "y" }, { op: "explode" } as never], bob, 1);
    assert.equal(ops.length, 0);
    assert.equal(errors.length, 2);
  });
  it("starts a comment thread from text", () => {
    const { doc, created } = translateAgentOps(emptyDoc(), [{ op: "create", ref: "c", type: "comment", text: "Why?", x: 5, y: 5 }], bob, 1);
    const c = doc.objects[created.c] as { thread: { text: string; author: { id: string } }[] };
    assert.equal(c.thread[0].text, "Why?");
    assert.equal(c.thread[0].author.id, "bob");
  });
});

describe("describeBoard", () => {
  it("lists objects with colour names, sections they sit in and votes", () => {
    let d = board([
      { k: "put", obj: { id: "s", type: "section", x: 0, y: 0, w: 1000, h: 1000, z: -1, title: "Ideas" } } as Op,
      { k: "put", obj: { id: "a", type: "sticky", x: 100, y: 100, z: 1, text: "Ship it", color: COLORS.green } } as Op,
    ]);
    d = applyOps(d, [{ k: "vote", id: "a", delta: 1 }], bob, 1);
    const lines = describeBoard(d).split("\n").map((l) => JSON.parse(l));
    const a = lines.find((l) => l.id === "a");
    assert.equal(a.color, "green");
    assert.equal(a.in, "s");
    assert.equal(a.votes, 1);
    assert.equal(lines.find((l) => l.id === "s").title, "Ideas");
  });
});
