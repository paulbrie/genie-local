import { NextResponse } from "next/server";
import { z } from "zod";

import { extractJson, runClaude } from "@/lib/claude-cli";
import { captureTerminal } from "@/lib/terminals";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

// Strip ANSI/VT escapes so the pane tail we feed the model is plain text.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Last `n` non-blank lines of a captured pane, de-escaped and length-capped. */
function tail(content: string, n: number): string {
  return content
    .replace(ANSI_RE, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.length > 0)
    .slice(-n)
    .map((l) => (l.length > 200 ? l.slice(0, 200) + "…" : l))
    .join("\n");
}

const bodySchema = z.object({
  // The terminals that just changed (the client's cheap gate decides these).
  changes: z
    .array(
      z.object({
        name: z.string().min(1).max(64),
        status: z.string().max(32),
        event: z.string().max(32), // "needs-input" | "finished" | "progress"
        tokensTotal: z.number().int().nonnegative().optional(),
      }),
    )
    .min(1)
    .max(12),
  // Recently spoken lines, so Jarvis doesn't repeat itself.
  recentlySaid: z.array(z.string().max(400)).max(24).default([]),
});

const utteranceSchema = z.object({
  name: z.string(),
  text: z.string().min(1).max(240),
  priority: z.enum(["high", "normal", "low"]).default("normal"),
});

/** Persona + rules + data → one headless prompt for `claude -p`. */
function buildPrompt(
  changed: { name: string; status: string; event: string; tail: string }[],
  recentlySaid: string[],
): string {
  const board = changed
    .map(
      (c) =>
        `### ${c.name}  [status: ${c.status}; event: ${c.event}]\n${c.tail || "(no visible output)"}`,
    )
    .join("\n\n");
  const said = recentlySaid.length
    ? recentlySaid.map((s) => `- ${s}`).join("\n")
    : "(nothing yet)";

  return [
    "You are Jarvis, an ambient voice assistant supervising a developer's terminal sessions at once.",
    "You are given ONLY the terminals that just changed, each with its status and the tail of its output.",
    "Decide which (if any) deserve a brief spoken update RIGHT NOW.",
    "",
    "Rules:",
    "- Speak only about genuinely useful events: a task finished, tests passed or failed, an error appeared, a server came up, or a session is now blocked waiting for the user's input.",
    "- Stay silent about routine churn, boilerplate, or anything close to what was already said.",
    "- One short spoken sentence per terminal, at most ~14 words, and START it with the terminal name.",
    "- Priority: a session waiting for the user's input = \"high\"; a failure or a finish = \"normal\"; incremental progress = \"low\".",
    "- If several finished together you may say so in one line. If nothing is worth saying, return an empty list.",
    "",
    'Reply with ONLY compact JSON, no markdown, no prose: {"utterances":[{"name":"...","text":"...","priority":"high|normal|low"}]}',
    "",
    "Recently said (do NOT repeat these):",
    said,
    "",
    "Changed terminals:",
    board,
  ].join("\n");
}

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid request" },
      { status: 400, headers: noStore },
    );
  }

  // Capture the current pane tail for each changed terminal (server-side, so the
  // client never ships large pane payloads around). A vanished session is skipped.
  // Cap the batch: the model is the bottleneck (~7s/terminal), so more than a
  // handful per call would blow the timeout — the rest roll to the next poll.
  const changed: { name: string; status: string; event: string; tail: string }[] =
    [];
  for (const c of parsed.data.changes.slice(0, 6)) {
    try {
      const snap = await captureTerminal(c.name);
      changed.push({
        name: c.name,
        status: c.status,
        event: c.event,
        tail: tail(snap.content, 30),
      });
    } catch {
      /* session gone between poll and narrate — skip it */
    }
  }
  if (changed.length === 0) {
    return NextResponse.json({ utterances: [] }, { headers: noStore });
  }

  const prompt = buildPrompt(changed, parsed.data.recentlySaid);

  // 40s timeout leaves room for a multi-terminal batch; still < nginx's 60s.
  try {
    const result = await runClaude(prompt, { timeoutMs: 40_000 });
    const out = z
      .object({ utterances: z.array(utteranceSchema).max(12) })
      .safeParse(extractJson(result));
    return NextResponse.json(
      { utterances: out.success ? out.data.utterances : [] },
      { headers: noStore },
    );
  } catch (e) {
    // A timeout or a bad parse just means "say nothing this round" — never 500 the
    // ambient loop.
    return NextResponse.json(
      { utterances: [], error: (e as Error).message },
      { headers: noStore },
    );
  }
}
