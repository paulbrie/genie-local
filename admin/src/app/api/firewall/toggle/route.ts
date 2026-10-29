// POST {enabled}: turn genie's egress firewall on (apply + enable the timer) or
// off (`genie-firewall off` + disable the timer and the boot-time service). It
// doesn't install the firewall: that's genie's job. The proxy checks the origin.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { setFirewallEnabled } from "@/lib/firewall";
import { requireAdmin } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

const Body = z.object({ enabled: z.boolean() });

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "invalid request" }, { status: 400 });
  const result = await setFirewallEnabled(parsed.data.enabled);
  return NextResponse.json(result, { status: result.ok ? 200 : 422, headers: { "Cache-Control": "no-store" } });
}
