/**
 * Claude as a board participant: runs the server's logged-in Claude Code CLI
 * (no API key, the host's subscription; the CLI's own default model) and turns
 * a board + a request into `{ reply, ops }`, where ops are the agent op
 * language of `translateAgentOps` in src/lib/boards/core.mjs.
 *
 * Same CLI rules as src/lib/claude-cli.ts (which raw Node can't import): stdin
 * must be /dev/null. How much a run can do is set by `tools`:
 *   none — text only, from /tmp with no project context. The facilitator uses
 *          this: nobody asked it for anything, so it only ever suggests.
 *   full — the same CLI the team's terminals get (shell, files, web) plus the
 *          real browser from boards-browser-mcp.mjs, working from the repo so
 *          the project's own guides are in context. Anyone signed in to the
 *          admin already has a shell there, so this hands a person nothing new;
 *          what it does mean is that a board's text — and any page Claude reads
 *          on it — reaches a prompt that can run commands. Only our MCP server
 *          is loaded (--strict-mcp-config), none of the account's others.
 * Runs stream, and a run can be stopped from the board (pass an AbortSignal).
 */
import { execFile, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describeBoard } from "../src/lib/boards/core.mjs";

const DISALLOWED = [
  "Bash",
  "Edit",
  "Write",
  "Read",
  "Glob",
  "Grep",
  "Task",
  "NotebookEdit",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
];
/** Where a full run works from, so the repo's CLAUDE.md / AGENTS.md apply. */
const FULL_CWD = process.env.BOARDS_CLAUDE_CWD || "/opt/project";
const BROWSER_MCP = fileURLToPath(new URL("./boards-browser-mcp.mjs", import.meta.url));
let browserRuns = 0;

const SECRET_ENV = ["ADMIN_USER", "ADMIN_PASSWORD", "APP_ENC_KEY", "DATABASE_URL", "DIAGRAMS_API_KEY", "BOARDS_API_KEY", "RAILWAY_API_TOKEN"];

/** Every process below `root`, deepest included. Linux /proc only; [] elsewhere. */
function descendantPids(root) {
  let pids;
  try {
    pids = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return [];
  }
  const children = new Map();
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The command name sits in brackets and may contain spaces: read past it.
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(pid));
    } catch {
      /* exited while we looked */
    }
  }
  const out = [];
  const walk = (pid) => {
    for (const kid of children.get(pid) ?? []) {
      out.push(kid);
      walk(kid);
    }
  };
  walk(root);
  return out;
}

let running = 0;
const MAX_CONCURRENT = 2;

export function claudeBusy() {
  return running >= MAX_CONCURRENT;
}

/**
 * What Claude is doing, in a few words, from one streamed content block —
 * for the board's chat and its cursor. Null for steps not worth showing.
 */
export function describeStep(block) {
  if (block?.type === "text") {
    // Claude's running commentary is worth showing; its closing JSON answer is
    // not (the caller posts that as the reply a moment later).
    const t = block.text?.trim();
    if (!t || t.startsWith("{") || t.startsWith("```")) return null;
    return t.slice(0, 200);
  }
  if (block?.type !== "tool_use") return null;
  const a = block.input ?? {};
  const host = (u) => {
    try {
      return new URL(u).host.replace(/^www\./, "");
    } catch {
      return String(u).slice(0, 60);
    }
  };
  switch (block.name) {
    case "mcp__browser__browser_open":
      return `Opening ${host(a.url)}…`;
    case "mcp__browser__browser_text":
      return "Reading the page…";
    case "mcp__browser__browser_snapshot":
      return "Looking at what's on the page…";
    case "mcp__browser__browser_click":
      return "Clicking through…";
    case "mcp__browser__browser_type":
      return "Filling something in…";
    case "mcp__browser__browser_scroll":
      return "Scrolling for more…";
    case "mcp__browser__browser_back":
      return "Going back…";
    case "Bash": {
      const cmd = String(a.command ?? "").replace(/\s+/g, " ").trim();
      return cmd ? `Running ${cmd.slice(0, 90)}` : "Running a command…";
    }
    case "Read":
      return `Reading ${String(a.file_path ?? "a file").split("/").pop()}…`;
    case "Write":
      return `Writing ${String(a.file_path ?? "a file").split("/").pop()}…`;
    case "Edit":
      return `Editing ${String(a.file_path ?? "a file").split("/").pop()}…`;
    case "Grep":
      return `Searching the code for ${JSON.stringify(String(a.pattern ?? "").slice(0, 40))}…`;
    case "Glob":
      return `Looking for files matching ${JSON.stringify(String(a.pattern ?? "").slice(0, 40))}…`;
    case "Task":
      return "Handing part of this to a subagent…";
    case "WebFetch":
      return `Fetching ${host(a.url)}…`;
    case "WebSearch":
      return `Searching the web for ${JSON.stringify(String(a.query ?? "").slice(0, 60))}…`;
    default:
      // Internal plumbing (ToolSearch and friends) isn't worth narrating.
      return null;
  }
}

/**
 * Run the CLI. `onStep(text)` is called as the work happens (see
 * describeStep); the promise still resolves with the final answer text.
 */
export function runClaudeCli(prompt, { timeoutMs, tools = "none", onStep, signal } = {}) {
  const full = tools === "full";
  // Long enough for real work; whoever is on the board can stop it sooner.
  timeoutMs ??= full ? 900_000 : 180_000;
  // Each run that can browse gets its own throwaway browser, closed at the end.
  const session = `board-claude-${process.pid}-${++browserRuns}`;
  const mcp = { mcpServers: { browser: { command: process.execPath, args: [BROWSER_MCP], env: { BOARDS_BROWSER_SESSION: session, PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/home/genie" } } } };
  return new Promise((resolve, reject) => {
    running++;
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      running--;
      signal?.removeEventListener("abort", onAbort);
      if (full) execFile("agent-browser", ["--session", session, "close"], { timeout: 10_000 }, () => {});
      fn(v);
    };
    const env = { ...process.env, HOME: process.env.HOME ?? "/home/genie" };
    // The admin's own Next/dev vars mean nothing to the CLI. Its secrets are
    // dropped so they can't fall into a prompt or a log by accident — with a
    // shell in hand this is tidiness, not a boundary: .env.local is readable.
    for (const k of Object.keys(env)) if (k.startsWith("__NEXT") || k === "TURBOPACK") delete env[k];
    for (const k of SECRET_ENV) delete env[k];
    const child = spawn(
      "claude",
      [
        "-p",
        prompt,
        // Streamed so the board can show what Claude is doing while it works;
        // the final answer arrives as the closing "result" event.
        "--output-format",
        "stream-json",
        "--verbose",
        "--strict-mcp-config",
        // Full: the CLI's own tools, unprompted, as in a terminal here — there
        // is no one at a keyboard to approve each one. Otherwise: no tools.
        ...(full
          ? ["--mcp-config", JSON.stringify(mcp), "--dangerously-skip-permissions"]
          : ["--disallowed-tools", ...DISALLOWED]),
      ],
      // Its own process group: a full run spawns shell commands of its own, and
      // stopping it has to take those with it rather than orphan them.
      { cwd: full ? FULL_CWD : "/tmp", env, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );

    // Stopping has to reach the commands Claude started, and the CLI puts those
    // in process groups of their own — so take the group, and every descendant
    // we can still see. Collected across passes: once the parent dies its
    // children are reparented to init and can't be found from it any more.
    const doomed = new Set();
    const killRun = (sig) => {
      for (const pid of descendantPids(child.pid)) doomed.add(pid);
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
      for (const pid of doomed) {
        try {
          process.kill(pid, sig);
        } catch {
          /* already gone */
        }
      }
    };
    let err = "";
    let pending = "";
    let answer = null;
    let failed = null;

    const onLine = (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // not an event line; the CLI prints nothing else, but be safe
      }
      if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          const step = describeStep(block);
          if (step && onStep) {
            try {
              onStep(step);
            } catch {
              /* a broken listener must not sink the run */
            }
          }
        }
        return;
      }
      if (msg.type === "result") {
        if (msg.subtype === "success" && typeof msg.result === "string") answer = msg.result;
        else failed = new Error(String(msg.result ?? msg.subtype ?? "Claude returned an error").slice(0, 300));
      }
    };
    const timer = setTimeout(() => {
      killRun("SIGKILL");
      done(reject, new Error("Claude took too long"));
    }, timeoutMs);

    // Stopped from the board: ask the CLI to wind up, then insist.
    let stopped = false;
    function onAbort() {
      stopped = true;
      killRun("SIGTERM");
      setTimeout(() => killRun("SIGKILL"), 2000).unref();
    }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => {
      pending += d;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      done(reject, e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      onLine(pending);
      // Killed from the board: say so plainly rather than as a failure.
      if (stopped) return done(reject, Object.assign(new Error("stopped"), { stopped: true }));
      if (code !== 0) return done(reject, new Error(err.trim().slice(0, 300) || `claude exited ${code}`));
      if (failed) return done(reject, failed);
      if (answer === null) return done(reject, new Error("Claude returned no answer"));
      done(resolve, answer);
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
  types: link ({"type":"link","url":"https://…","title":"optional","desc":"optional"}), task (a card for an existing ticket of a project on this server: {"type":"task","project":"<project slug>","taskId":123,"title":"the ticket's title"}; the card shows its live status and opens it), table ({"type":"table","rows":[["Header","Header"],["cell","cell"]]} — the first row is the header), sticky (200x200 by default), text (a free text label; "fontSize"), shape ("shape": rect|roundrect|ellipse|diamond|triangle, with "text"; good for flowcharts), section (a titled frame, "title", "w", "h"; it sits behind the items it groups, so make it big enough to contain them with 40px padding), comment ("text"; a comment pin).
  "ref" is your own name for the new item, so later ops in the same list can point at it.
  Leave out x and y to let the board find free space.
- {"op":"connect","from":"<id or ref>","to":"<id or ref>","label":"optional"}   an arrow between two items; it curves, meeting each shape square-on, unless you pass "straight":true
- {"op":"update","id":"<id or ref>", …only the fields to change: x, y, w, h, text, title, color, shape, label}
- {"op":"delete","id":"<id>"}   only when asked to remove something
- {"op":"arrange","id":"<section id>"}  tidy that section's contents onto a grid and size the section to match
- {"op":"fit","id":"<section id>"}      resize a section around what it already holds
- a section takes {"collapsed":true} to fold it to a bar, or false to open it
- {"op":"reply","id":"<comment id>","text":"…"}
Sticky, text and shape text is Markdown: **bold**, lists, code spans, [links](url), and GFM pipe tables all render. A sticky or text whose whole content is one URL shows as a link card.
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

const WEB_HELP = `You can read the web: WebFetch for ordinary pages, WebSearch to search, and a real browser (browser_open, browser_text, browser_snapshot, browser_click, browser_type, browser_scroll, browser_back) for pages that need JavaScript or clicking through. When someone gives a link or asks about something online, look it up rather than guessing, and put what you found on the board.`;

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
${WEB_HELP}

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
${WEB_HELP}

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
