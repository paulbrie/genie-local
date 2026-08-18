import { NextResponse } from "next/server";
import { z } from "zod";

import {
  captureTerminal,
  renameTerminal,
  resizeTerminal,
  sendKey,
  sendText,
} from "@/lib/terminals";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/** Read the current pane contents of one terminal. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  try {
    const { content, size, command, busy, status } =
      await captureTerminal(name);
    return NextResponse.json(
      { content, size, command, busy, status },
      { headers: noStore },
    );
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 404, headers: noStore },
    );
  }
}

const inputSchema = z.object({
  text: z.string().max(10_000).optional(),
  key: z.string().max(16).optional(),
  resize: z
    .object({ cols: z.number().int(), rows: z.number().int() })
    .optional(),
});

/** Send input (literal text and/or a named key) or resize the window. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const json = await req.json().catch(() => null);
  const parsed = inputSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid request" },
      { status: 400, headers: noStore },
    );
  }
  const { text, key, resize } = parsed.data;
  try {
    if (resize) await resizeTerminal(name, resize.cols, resize.rows);
    if (text) await sendText(name, text);
    if (key) await sendKey(name, key);
    // For input (not resize-only), return the fresh pane in this same response
    // so the client echoes in a single round-trip instead of a POST followed by
    // a separate GET. A short settle delay lets the shell's echo land in the
    // capture; the client's optimistic local echo covers any residual gap.
    if (text || key) {
      await new Promise((r) => setTimeout(r, 15));
      try {
        const snap = await captureTerminal(name);
        return NextResponse.json({ ok: true, ...snap }, { headers: noStore });
      } catch {
        /* fall through to the bare ok — the client's poll will catch up */
      }
    }
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 422, headers: noStore },
    );
  }
}

const renameSchema = z.object({ name: z.string().min(1).max(31) });

/** Rename a terminal (tmux rename-session). */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const json = await req.json().catch(() => null);
  const parsed = renameSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid request" },
      { status: 400, headers: noStore },
    );
  }
  try {
    const terminal = await renameTerminal(name, parsed.data.name);
    return NextResponse.json({ terminal }, { headers: noStore });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 422, headers: noStore },
    );
  }
}
