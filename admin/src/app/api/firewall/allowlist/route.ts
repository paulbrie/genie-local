// POST {entry}: allow a domain / IPv4 address / IPv4 range; DELETE {entry}:
// remove one (never api.anthropic.com or genie's auto-added address). Both
// re-apply the firewall only while it's enforced, and answer with the fresh
// status. The proxy checks the origin of both.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { allowFirewallEntry, removeFirewallEntry } from "@/lib/firewall";
import type { FirewallResult } from "@/lib/firewall-core";
import { requireAdmin } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

const Body = z.object({ entry: z.string().max(300) });

async function handle(req: NextRequest, fn: (entry: string) => Promise<FirewallResult>) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "invalid request" }, { status: 400 });
  const result = await fn(parsed.data.entry);
  return NextResponse.json(result, { status: result.ok ? 200 : 422, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  return handle(req, allowFirewallEntry);
}

export async function DELETE(req: NextRequest) {
  return handle(req, removeFirewallEntry);
}
