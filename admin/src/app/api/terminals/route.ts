import { NextResponse } from "next/server";
import { z } from "zod";

import { createTerminal, killTerminal, listTerminals } from "@/lib/terminals";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/** List admin-managed tmux terminals. */
export async function GET() {
  try {
    const terminals = await listTerminals();
    return NextResponse.json({ terminals }, { headers: noStore });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500, headers: noStore },
    );
  }
}

const createSchema = z.object({
  name: z.string().min(1).max(31),
  cols: z.number().int().optional(),
  rows: z.number().int().optional(),
});

/** Create a new detached tmux session (survives UI disconnect). */
export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid request" },
      { status: 400, headers: noStore },
    );
  }
  try {
    const terminal = await createTerminal(parsed.data.name, {
      cols: parsed.data.cols,
      rows: parsed.data.rows,
    });
    return NextResponse.json({ terminal }, { headers: noStore });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 422, headers: noStore },
    );
  }
}

/** Kill a terminal by ?name=. */
export async function DELETE(req: Request) {
  const name = new URL(req.url).searchParams.get("name");
  if (!name) {
    return NextResponse.json(
      { error: "missing name" },
      { status: 400, headers: noStore },
    );
  }
  try {
    await killTerminal(name);
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 422, headers: noStore },
    );
  }
}
