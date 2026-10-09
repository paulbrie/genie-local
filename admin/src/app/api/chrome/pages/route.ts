import { NextResponse } from "next/server";

import { findInstance, listChromePages } from "@/lib/chrome";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/** Pages (tabs) open in one Chrome instance. `?dir=<user-data-dir>`. */
export async function GET(req: Request) {
  const dir = new URL(req.url).searchParams.get("dir");
  if (!dir) {
    return NextResponse.json(
      { error: "missing dir" },
      { status: 400, headers: noStore },
    );
  }
  const inst = await findInstance(dir);
  if (!inst) {
    return NextResponse.json(
      { error: "the instance is no longer running", pages: [] },
      { status: 404, headers: noStore },
    );
  }
  if (inst.devtoolsPort == null) {
    return NextResponse.json(
      { error: inst.notViewable, pages: [] },
      { status: 200, headers: noStore },
    );
  }
  const pages = await listChromePages(inst.devtoolsPort);
  return NextResponse.json({ port: inst.devtoolsPort, pages }, { headers: noStore });
}
