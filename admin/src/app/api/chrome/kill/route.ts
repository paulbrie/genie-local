import { NextResponse } from "next/server";
import { z } from "zod";

import {
  killAllChromeInstances,
  killChromeInstance,
  type KillInstanceResult,
} from "@/lib/chrome";

export const dynamic = "force-dynamic";

const bodySchema = z.union([
  z.object({
    userDataDir: z.string().min(1).max(4096),
    signal: z.enum(["SIGTERM", "SIGKILL"]).optional(),
  }),
  z.object({
    all: z.literal(true),
    agentBrowserOnly: z.boolean().optional(),
    signal: z.enum(["SIGTERM", "SIGKILL"]).optional(),
  }),
]);

/** Kill one Chrome instance, or all of them. Auth is enforced by proxy.ts. */
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

  const signal = parsed.data.signal ?? "SIGTERM";
  let results: KillInstanceResult[];
  if ("all" in parsed.data) {
    results = await killAllChromeInstances(
      signal,
      parsed.data.agentBrowserOnly ?? false,
    );
  } else {
    results = [await killChromeInstance(parsed.data.userDataDir, signal)];
  }

  const killed = results.reduce((s, r) => s + r.killed, 0);
  const failed = results.flatMap((r) => r.failed);
  return NextResponse.json(
    { results, killed, failed },
    {
      status: failed.length > 0 && killed === 0 ? 422 : 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
