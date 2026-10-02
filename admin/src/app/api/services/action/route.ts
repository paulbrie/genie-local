import { NextResponse } from "next/server";
import { z } from "zod";

import {
  isServiceAction,
  isServiceUnit,
  runServiceAction,
} from "@/lib/services";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  unit: z.string().refine(isServiceUnit, "invalid unit name"),
  action: z.string().refine(isServiceAction, "unsupported action"),
});

/** Run a systemd lifecycle action on a unit. Auth is enforced by proxy.ts. */
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

  const { unit, action } = parsed.data;
  const result = await runServiceAction(unit, action);
  return NextResponse.json(result, {
    status: result.ok ? 200 : 422,
    headers: { "Cache-Control": "no-store" },
  });
}
