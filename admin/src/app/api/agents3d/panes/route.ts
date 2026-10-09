import { NextResponse } from "next/server";

import { capturePanes } from "@/lib/panes";

export const dynamic = "force-dynamic";

/**
 * Live, redacted text of agents' tmux panes for the Agents City cards.
 * Behind the admin login like every /api route (src/proxy.ts). Read-only.
 *
 * GET /api/agents3d/panes?keys=s:<id>,s:<id>&lines=40&h=<key>:<hash>,…
 *   keys   which sessions (node keys) to capture; at most 24
 *   h      hashes the client already has: unchanged panes come back without text
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const keys = (searchParams.get("keys") ?? "").split(",").filter((k) => /^s:[0-9a-f-]{36}$/.test(k));
  const lines = Number(searchParams.get("lines")) || 40;
  const have = new Map(
    (searchParams.get("h") ?? "")
      .split(",")
      .map((kv) => kv.split("="))
      .filter((p) => p.length === 2) as [string, string][],
  );
  const caps = await capturePanes(keys, lines);
  const panes = Object.fromEntries(
    Object.entries(caps).map(([k, c]) => [k, c.hash && have.get(k) === c.hash ? { ...c, text: undefined, unchanged: true } : c]),
  );
  return NextResponse.json({ panes }, { headers: { "Cache-Control": "no-store" } });
}
