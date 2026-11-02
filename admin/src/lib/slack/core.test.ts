/**
 * The Slack bot's pure core: commands and replies as typed, Slack's text
 * encoding, what of a pane is posted, the choices a prompt offers, and which
 * terminal changes are alerts.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { TermStatus } from "@/lib/terminals";

import {
  ALERT_COOLDOWN_MS,
  alertMessage,
  detectAlerts,
  paneExcerpt,
  parseAllowed,
  parseChoices,
  parseCommand,
  parseReply,
  slackToPlain,
  tasksText,
  type WatchMem,
} from "./core";

describe("parseAllowed", () => {
  it("keeps Slack user ids, whatever separates them", () => {
    assert.deepEqual([...parseAllowed(" U012AB3CD, W045EF6GH\nnope U9")], ["U012AB3CD", "W045EF6GH"]);
    assert.equal(parseAllowed(undefined).size, 0);
  });
});

describe("slackToPlain", () => {
  it("decodes links, mentions and entities, and drops the bot's own mention", () => {
    assert.equal(slackToPlain("<@UBOT> send x see <https://a.b/c?d=1|a.b/c> &amp; a &lt;b&gt;", "UBOT"), "send x see https://a.b/c?d=1 & a <b>");
    assert.equal(slackToPlain("hi <@U123> in <#C1|general> <mailto:a@b.c|a@b.c>"), "hi @U123 in #general a@b.c");
  });
});

describe("parseCommand", () => {
  it("reads every verb", () => {
    assert.deepEqual(parseCommand(""), { kind: "status" });
    assert.deepEqual(parseCommand("help"), { kind: "help" });
    assert.deepEqual(parseCommand("show trafficsim-64"), { kind: "show", terminal: "trafficsim-64", lines: 30 });
    assert.deepEqual(parseCommand("show Tom 500"), { kind: "show", terminal: "Tom", lines: 120 });
    assert.deepEqual(parseCommand('send "my term" run the\n tests'), { kind: "send", terminal: "my term", text: "run the tests" });
    assert.deepEqual(parseCommand("key Tom ESC"), { kind: "key", terminal: "Tom", key: "esc" });
    assert.deepEqual(parseCommand("ask what is Tom doing?"), { kind: "ask", question: "what is Tom doing?" });
    assert.deepEqual(parseCommand("tasks trafficsim all"), { kind: "tasks", project: "trafficsim", all: true });
    assert.deepEqual(parseCommand("task add trafficsim Fix the  replay bar"), { kind: "task-add", project: "trafficsim", title: "Fix the replay bar" });
    assert.deepEqual(parseCommand("task done trafficsim #116"), { kind: "task-status", project: "trafficsim", id: 116, status: "done" });
    assert.deepEqual(parseCommand("task start trafficsim 3"), { kind: "task-status", project: "trafficsim", id: 3, status: "in_progress" });
    assert.deepEqual(parseCommand("mute"), { kind: "mute", terminal: null });
    assert.deepEqual(parseCommand("unmute Tom"), { kind: "unmute", terminal: "Tom" });
  });

  it("says what's missing", () => {
    for (const s of ["show", "send Tom", "key Tom", "key Tom f13", "ask", "tasks", "task add x", "task done x y", "task frob x 1", "wat"]) {
      assert.equal(parseCommand(s).kind, "error", s);
    }
  });
});

describe("parseReply", () => {
  it("types a line, but not into a choice", () => {
    assert.deepEqual(parseReply("run the\ntests", "claude-idle"), { kind: "line", text: "run the tests" });
    assert.deepEqual(parseReply("2", "claude-input"), { kind: "key", key: { text: "2" } });
    assert.equal(parseReply("yes please", "claude-input").kind, "error");
    // A digit is just text when nothing is being chosen.
    assert.deepEqual(parseReply("2", "claude-idle"), { kind: "line", text: "2" });
  });

  it("presses !keys", () => {
    assert.deepEqual(parseReply("!esc", "claude-input"), { kind: "key", key: { named: "Escape" } });
    assert.deepEqual(parseReply("!ctrl-c", "busy"), { kind: "key", key: { named: "C-c" } });
    assert.equal(parseReply("!f13", "busy").kind, "error");
  });
});

const PANE = [
  "\x1b[1m● Done.\x1b[0m The tests pass.",
  "",
  "  I've committed it as abc123.",
  "",
  "✻ Crunched for 50s · done 1:08 PM",
  "─".repeat(60),
  "❯ ",
  "─".repeat(60),
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
  "",
  "",
].join("\n");

describe("paneExcerpt", () => {
  it("cuts a resting Claude's input box and footer", () => {
    assert.equal(paneExcerpt(PANE, "claude-idle"), "● Done. The tests pass.\n\n  I've committed it as abc123.\n\n✻ Crunched for 50s · done 1:08 PM");
  });

  it("keeps the whole end of the screen otherwise, within the limits", () => {
    assert.ok(paneExcerpt(PANE, null).endsWith("auto mode on (shift+tab to cycle)"));
    assert.equal(paneExcerpt("a\nb\nc\nd", null, 2), "c\nd");
    const long = paneExcerpt("x".repeat(5000), null, 30, 100);
    assert.equal(long.length, 100);
    assert.ok(long.startsWith("…"));
  });
});

describe("parseChoices", () => {
  const prompt = [
    "Here's the plan:",
    "1. Edit the file",
    "2. Run the tests",
    "",
    "─".repeat(40),
    " Bash command",
    "   npm test",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again for npm test commands in /opt/project",
    "   3. No, and tell Claude what to do differently (esc)",
  ].join("\n");

  it("reads the options the ❯ points into, not a list further up", () => {
    assert.deepEqual(parseChoices(prompt), [
      { n: 1, label: "Yes" },
      { n: 2, label: "Yes, and don't ask again for npm test commands in /opt/project" },
      { n: 3, label: "No, and tell Claude what to do differently (esc)" },
    ]);
  });

  it("finds nothing without a ❯ on a number", () => {
    assert.deepEqual(parseChoices("1. a\n2. b\n❯ "), []);
  });

  it("skips the descriptions between options", () => {
    const ask = ["❯ 1. Inside admin", "     Started from server.mjs", "  2. Separate service", "     Its own unit", "  3. Type something."].join("\n");
    assert.deepEqual(parseChoices(ask).map((c) => c.n), [1, 2, 3]);
  });
});

describe("detectAlerts", () => {
  const poll = (mem: Map<string, WatchMem>, status: TermStatus, now: number) =>
    detectAlerts(mem, [{ name: "t", status }], now);

  function run(statuses: TermStatus[], start = 0, step = 3000) {
    let mem = new Map<string, WatchMem>();
    const out: string[] = [];
    statuses.forEach((s, i) => {
      const r = poll(mem, s, start + i * step);
      mem = r.mem;
      for (const a of r.alerts) out.push(`${i}:${a.event}`);
    });
    return out;
  }

  it("says nothing at first sight", () => {
    assert.deepEqual(run(["claude-idle", "claude-idle"]), []);
    assert.deepEqual(run(["claude-input", "claude-input"]), []);
  });

  it("alerts a finished turn once the rest has held for two polls", () => {
    assert.deepEqual(run(["claude-idle", "claude-working", "claude-working", "claude-idle", "claude-idle", "claude-idle"]), ["4:finished"]);
  });

  it("ignores a one-poll blink between steps", () => {
    assert.deepEqual(run(["claude-working", "claude-idle", "claude-working", "claude-working"]), []);
  });

  it("alerts a prompt, and the turn that finishes after it is answered", () => {
    assert.deepEqual(
      run(["claude-working", "claude-input", "claude-input", "claude-working", "claude-idle", "claude-background"]),
      ["2:needs-input", "5:finished"],
    );
  });

  it("doesn't call a terminal that was never working finished", () => {
    assert.deepEqual(run(["busy", "claude-idle", "claude-idle"]), []);
  });

  it("alerts a quick second turn", () => {
    assert.deepEqual(run(["claude-working", "claude-idle", "claude-idle", "claude-working", "claude-idle", "claude-idle"]), ["2:finished", "5:finished"]);
  });

  it("holds back a prompt alert within the cooldown", () => {
    const seq: TermStatus[] = ["claude-working", "claude-input", "claude-input", "claude-working", "claude-input", "claude-input"];
    assert.deepEqual(run(seq), ["2:needs-input"]);
    assert.deepEqual(run(seq, 0, ALERT_COOLDOWN_MS / 2), ["2:needs-input", "5:needs-input"]);
  });

  it("forgets terminals that are gone", () => {
    const first = detectAlerts(new Map(), [{ name: "a", status: "idle" }], 0);
    assert.deepEqual([...detectAlerts(first.mem, [], 1).mem.keys()], []);
  });
});

describe("messages", () => {
  it("puts a button on each choice, escapes the screen", () => {
    const m = alertMessage("t<1>", "needs-input", "a < b", [{ n: 1, label: "Yes" }, { n: 2, label: "No" }]);
    const json = JSON.stringify(m.blocks);
    assert.ok(json.includes("a &lt; b"));
    assert.ok(json.includes("t&lt;1&gt;"));
    const actions = m.blocks.find((b) => b.type === "actions") as { elements: { action_id: string; value: string }[] };
    assert.deepEqual(actions.elements.map((e) => e.action_id), ["genie_key:1", "genie_key:2", "genie_key:esc", "genie_show:show"]);
    assert.deepEqual(JSON.parse(actions.elements[1].value), { t: "t<1>", k: "2" });
  });

  it("lists open tasks, in progress first", () => {
    const text = tasksText("p", [
      { id: 1, title: "a", status: "open", assignee: null },
      { id: 2, title: "b", status: "done", assignee: null },
      { id: 3, title: "c", status: "in_progress", assignee: "Tom" },
    ], false);
    assert.equal(text, "*p*\n:arrow_forward: #3 c · _Tom_\n:white_square: #1 a");
  });
});
