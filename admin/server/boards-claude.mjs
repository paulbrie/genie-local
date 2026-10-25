/**
 * Claude as a board participant: runs the server's logged-in Claude Code CLI
 * (no API key, the host's subscription; the CLI's own default model) and turns
 * a board + a request into `{ reply, ops }`, where ops are the agent op
 * language of `translateAgentOps` in src/lib/boards/core.mjs.
 *
 * Same CLI rules as src/lib/claude-cli.ts (which raw Node can't import): stdin
 * must be /dev/null, every tool is disallowed so a prompt can only produce
 * text, and it runs from /tmp so no project CLAUDE.md leaks into context.
 */
import { spawn } from "node:child_process";

import { describeBoard } from "../src/lib/boards/core.mjs";

const DISALLOWED = [
  "Bash",
  "Edit",
  "Write",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "NotebookEdit",
  "TodoWrite",
];

const SECRET_ENV = ["ADMIN_USER", "ADMIN_PASSWORD", "APP_ENC_KEY", "DATABASE_URL", "DIAGRAMS_API_KEY", "BOARDS_API_KEY", "RAILWAY_API_TOKEN"];

let running = 0;
const MAX_CONCURRENT = 2;

export function claudeBusy() {
  return running >= MAX_CONCURRENT;
}

export function runClaudeCli(prompt, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    running++;
    const done = (fn, v) => {
      running--;
      fn(v);
    };
    const env = { ...process.env, HOME: process.env.HOME ?? "/home/genie" };
    // The admin's own Next/dev vars mean nothing to the CLI, and its secrets
    // stay out of reach of whatever a board's content asks for.
    for (const k of Object.keys(env)) if (k.startsWith("__NEXT") || k === "TURBOPACK") delete env[k];
    for (const k of SECRET_ENV) delete env[k];
    const child = spawn(
      "claude",
      ["-p", prompt, "--output-format", "json", "--disallowed-tools", ...DISALLOWED],
      { cwd: "/tmp", env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(reject, new Error("Claude took too long"));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      done(reject, e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return done(reject, new Error(err.trim().slice(0, 300) || `claude exited ${code}`));
      try {
        const env = JSON.parse(out);
        if (env.is_error || typeof env.result !== "string") return done(reject, new Error("Claude returned an error"));
        done(resolve, env.result);
      } catch (e) {
        done(reject, e);
      }
    });
  });
}

/** Pull a JSON object out of possibly-fenced model text. Throws on no JSON. */
export function extractJson(raw) {
  let t = raw.trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

const OPS_HELP = `Ops you can use (a JSON array, applied in order):
- {"op":"create","ref":"n1","type":"sticky","x":100,"y":100,"text":"…","color":"yellow"}
  types: sticky (200x200 by default), text (a free text label; "fontSize"), shape ("shape": rect|roundrect|ellipse|diamond|triangle, with "text"; good for flowcharts), section (a titled frame, "title", "w", "h"; it sits behind the items it groups, so make it big enough to contain them with 40px padding), comment ("text"; a comment pin).
  "ref" is your own name for the new item, so later ops in the same list can point at it.
  Leave out x and y to let the board find free space.
- {"op":"connect","from":"<id or ref>","to":"<id or ref>","label":"optional"}   an arrow between two items
- {"op":"update","id":"<id or ref>", …only the fields to change: x, y, w, h, text, title, color, shape, label}
- {"op":"delete","id":"<id>"}   only when asked to remove something
- {"op":"reply","id":"<comment id>","text":"…"}
Colours: yellow, orange, red, pink, purple, blue, teal, green, gray, white.
Coordinates are board pixels: x grows right, y grows down, x/y is an item's top-left corner. Lay things out tidily on a grid with about 40px gaps; don't drop new items on top of existing ones unless you are rearranging them.`;

function boardBlock(doc, title, focusIds) {
  const total = Object.keys(doc.objects).length;
  let only;
  // Big boards: everything near the focus plus a sample, so the prompt stays small.
  if (total > 400 && focusIds?.size) {
    only = new Set(focusIds);
    for (const o of Object.values(doc.objects)) {
      if (only.size >= 400) break;
      if (o.type === "section" || o.type === "comment") only.add(o.id);
    }
  }
  const body = describeBoard(doc, { only, maxText: total > 150 ? 200 : 500, names: true });
  return `Board "${title}" (${total} items${only ? `, showing ${only.size}` : ""}):\n${body || "(empty board)"}`;
}

function chatBlock(doc, n = 12) {
  const recent = doc.chat.filter((m) => !m.pending).slice(-n);
  if (!recent.length) return "";
  return `\nRecent chat with you:\n${recent.map((m) => `${m.author.name}: ${m.text}`).join("\n")}\n`;
}

function viewportLine(vp) {
  if (!vp) return "";
  return `Their screen shows the area x=${Math.round(vp.x)}..${Math.round(vp.x + vp.w)}, y=${Math.round(vp.y)}..${Math.round(vp.y + vp.h)}; put new things there unless told otherwise.\n`;
}

const ANSWER = `Answer with ONLY a JSON object, no prose around it:
{"reply": "a short, friendly message to the group (plain text, under 600 characters)", "ops": [ … ]}
Use "ops": [] when the request needs no board changes.`;

/** An @mention in the Claude panel. */
export function askPrompt({ doc, title, people, asker, text, selection, viewport }) {
  const sel = selection?.length ? `They have selected: ${selection.join(", ")}.\n` : "";
  return `You are Claude, one of the participants on a shared FigJam-style whiteboard. Also here: ${people.join(", ") || "nobody else"}.
${asker} asked you: ${JSON.stringify(text)}
${sel}${viewportLine(viewport)}
${boardBlock(doc, title, new Set(selection ?? []))}
${chatBlock(doc)}
${OPS_HELP}

${ANSWER}`;
}

/** "@claude" in a comment thread: the reply goes into the thread. */
export function commentPrompt({ doc, title, people, comment }) {
  const near = Object.values(doc.objects)
    .filter((o) => o.type !== "comment" && o.type !== "connector")
    .sort(
      (a, b) =>
        Math.hypot(a.x + a.w / 2 - comment.x, a.y + a.h / 2 - comment.y) -
        Math.hypot(b.x + b.w / 2 - comment.x, b.y + b.h / 2 - comment.y),
    )
    .slice(0, 3)
    .map((o) => o.id);
  return `You are Claude, one of the participants on a shared FigJam-style whiteboard. Also here: ${people.join(", ") || "nobody else"}.
You were mentioned in comment ${comment.id} at x=${Math.round(comment.x)}, y=${Math.round(comment.y)} (nearest items: ${near.join(", ") || "none"}).
The thread so far:
${comment.thread.map((m) => `${m.author.name}: ${m.text}`).join("\n")}

${boardBlock(doc, title, new Set([comment.id, ...near]))}

${OPS_HELP}

Your "reply" is posted in that comment thread.
${ANSWER}`;
}

/** The facilitator's look at a board after the group went quiet. */
export function facilitatorPrompt({ doc, title, people, recent }) {
  return `You are Claude, quietly facilitating a session on a shared FigJam-style whiteboard with ${people.join(", ")}.
The group has just paused. Recently changed: ${recent.join(", ") || "various items"}.

${boardBlock(doc, title, new Set(recent))}
${chatBlock(doc, 6)}
Only chime in if you add real value, for example: group stickies into themes, point out a duplicate or a gap, raise a question nobody asked, or sum up where things stand. Most of the time the right answer is to stay silent: {"reply": "", "ops": []}.
When you do contribute, keep it to at most 3 new stickies or comments placed next to what they relate to; they appear as suggestions the group can accept or dismiss. Use only "create" ops (types sticky or comment). Keep "reply" to one or two sentences, or leave it empty.

${OPS_HELP}

${ANSWER}`;
}
