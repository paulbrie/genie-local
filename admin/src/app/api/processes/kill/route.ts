import { NextResponse } from "next/server";
import { z } from "zod";

import { isKillSignal, killProcess } from "@/lib/processes";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  pid: z.number().int().positive().max(2 ** 31 - 1),
  signal: z
    .string()
    .refine(isKillSignal, "unsupported signal")
    .optional(),
  tree: z.boolean().optional(),
});

/** Signal a process (optionally its spawn subtree). Auth is enforced by proxy.ts. */
export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid request" },
      { status: 400 },
    );
  }

  const { pid, signal, tree } = parsed.data;
  const result = await killProcess(pid, {
    signal: signal && isKillSignal(signal) ? signal : undefined,
    tree,
  });

  const anyOk = result.outcomes.some((o) => o.ok);
  return NextResponse.json(result, {
    status: anyOk ? 200 : 422,
    headers: { "Cache-Control": "no-store" },
  });
}
