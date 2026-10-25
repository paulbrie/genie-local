import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { describeBoard, type AgentOp } from "@/lib/boards/core.mjs";
import { boardsHub, parseBoardId } from "@/lib/boards/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  // Shown as the agent's name on its cursor (e.g. "alex" or "ticket #12").
  agent: z.string().trim().min(1).max(40),
  ops: z.array(z.record(z.string(), z.unknown())).max(200),
  // Optional message posted in the board's chat.
  chat: z.string().max(4000).optional(),
});

/**
 * Edit a board as an agent, live: everyone on it sees the agent's cursor make
 * the changes. `ops` use the agent op language (src/lib/boards/core.mjs,
 * translateAgentOps):
 *   { op: "create", ref?, type: sticky|text|shape|section|comment, x?, y?, w?, h?, text?, title?, color?, shape? }
 *   { op: "connect", from: id|ref, to: id|ref, label? }
 *   { op: "update", id: id|ref, ...fields }   { op: "delete", id }   { op: "reply", id: commentId, text }
 * Returns how many applied, `created` (ref → id), per-op `errors` and the
 * board's text after the change.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const id = parseBoardId((await params).id);
  if (id === null) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const hub = boardsHub();
  if (!hub) return NextResponse.json({ error: "the board hub isn't running (start the admin with server.mjs)" }, { status: 503 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const { agent, ops, chat } = parsed.data;
  const result = await hub.applyAgentOps(id, agent, ops as AgentOp[], { chat });
  if (!result) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    applied: result.applied,
    created: result.created,
    errors: result.errors,
    text: describeBoard(result.doc),
  });
}
