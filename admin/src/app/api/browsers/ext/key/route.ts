import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { extLink } from "@/lib/browsers/ext";
import { isNamedKey, listTerminals, sendKey, sendText } from "@/lib/terminals";

export const dynamic = "force-dynamic";

const schema = z.object({ terminal: z.string().min(1).max(64), key: z.string().min(1).max(10) });

/** One key into a terminal from the chat bubble: a named one (Enter, Escape, Up…) or a digit (a Claude choice). */
export async function POST(req: NextRequest) {
  if (!(await extLink(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const { terminal, key } = parsed.data;
  if (!(await listTerminals()).some((t) => t.name === terminal && !t.dead)) {
    return NextResponse.json({ error: `"${terminal}" is gone` }, { status: 404 });
  }
  if (/^\d$/.test(key)) await sendText(terminal, key);
  else if (isNamedKey(key)) await sendKey(terminal, key);
  else return NextResponse.json({ error: `unknown key ${key}` }, { status: 400 });
  return NextResponse.json({ ok: true });
}
