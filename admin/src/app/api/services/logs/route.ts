import { NextResponse } from "next/server";

import { isServiceUnit, serviceLogs } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Recent journald lines for a unit. `?unit=<name>.service&lines=<n>`. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const unit = url.searchParams.get("unit") ?? "";
  const lines = Number(url.searchParams.get("lines") ?? "500");

  if (!isServiceUnit(unit)) {
    return NextResponse.json({ error: "invalid unit name" }, { status: 400 });
  }

  const result = await serviceLogs(unit, Number.isFinite(lines) ? lines : 500);
  return NextResponse.json(result, {
    status: result.ok ? 200 : 422,
    headers: { "Cache-Control": "no-store" },
  });
}
