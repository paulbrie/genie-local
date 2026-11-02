import { NextResponse } from "next/server";
import { z } from "zod";

import { askAboutTerminals } from "@/lib/terminal-qa";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

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

  try {
    const answer = await askAboutTerminals(parsed.data.question, "voice");
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
