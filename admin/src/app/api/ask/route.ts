import { NextResponse } from "next/server";
import { z } from "zod";

import { runClaude } from "@/lib/claude-cli";
import { captureTerminal, listTerminals } from "@/lib/terminals";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function tail(content: string, n: number): string {
  return content
    .replace(ANSI_RE, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.length > 0)
    .slice(-n)
    .map((l) => (l.length > 180 ? l.slice(0, 180) + "…" : l))
    .join("\n");
}

const bodySchema = z.object({ question: z.string().min(1).max(500) });

/**
 * Conversational Jarvis: the developer asks a question by voice; we snapshot the
 * current state of every terminal and let Claude (CLI, no API key) answer in a
 * sentence or two, which the client speaks. This is Phase 2 of Jarvis mode.
 */
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request" },
      { status: 400, headers: noStore },
    );
  }

  // Snapshot the board: names + status + tokens, with a short tail per terminal
  // (capped so the prompt — and latency — stay bounded).
  let terminals: Awaited<ReturnType<typeof listTerminals>> = [];
  try {
    terminals = await listTerminals();
  } catch {
    /* no tmux server yet → empty board */
  }

  const board: string[] = [];
  for (const t of terminals.slice(0, 8)) {
    let paneTail = "";
    try {
      paneTail = tail((await captureTerminal(t.name)).content, 18);
    } catch {
      /* skip a vanished session's tail */
    }
    const tok = t.tokens ? ` ${t.tokens.total.toLocaleString()} tokens` : "";
    board.push(
      `### ${t.name}  [${t.status}${tok}]\n${paneTail || "(no visible output)"}`,
    );
  }

  const prompt = [
    "You are Jarvis, a calm, concise voice assistant for a developer who supervises several terminal sessions.",
    "They just asked you this out loud:",
    `"${parsed.data.question}"`,
    "",
    "Answer in ONE or TWO short spoken sentences, first person, conversational — it will be read aloud, so no markdown, lists, or code.",
    "Base your answer ONLY on the terminal states below. If they don't contain the answer, say briefly that you can't tell from the terminals.",
    "",
    board.length
      ? `Current terminals:\n${board.join("\n\n")}`
      : "There are no terminal sessions running right now.",
  ].join("\n");

  try {
    const answer = (await runClaude(prompt, { timeoutMs: 40_000 }))
      .replace(/^```(?:\w+)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    return NextResponse.json(
      { answer: answer || "I'm not sure how to answer that." },
      { headers: noStore },
    );
  } catch (e) {
    return NextResponse.json(
      { answer: "Sorry, I couldn't reach my brain just now.", error: (e as Error).message },
      { headers: noStore },
    );
  }
}
