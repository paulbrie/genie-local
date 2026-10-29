// GET: genie's egress firewall on this server — installed / enforced / allowed
// count, the allowlist, the last 24 h of blocks (with reverse DNS) and when the
// timer last re-applied it. Read-only; the changes are ./allowlist and ./toggle.
import { NextResponse } from "next/server";

import { loadFirewallStatus } from "@/lib/firewall";
import { requireAdmin } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await loadFirewallStatus(), { headers: { "Cache-Control": "no-store" } });
}
