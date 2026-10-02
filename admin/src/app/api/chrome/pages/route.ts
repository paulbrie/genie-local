import { NextResponse } from "next/server";

import {
  devtoolsPort,
  isValidInstanceDir,
  listChromePages,
} from "@/lib/chrome";

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
  if (!isValidInstanceDir(dir)) {
    return NextResponse.json(
      { error: "invalid instance dir" },
      { status: 400, headers: noStore },
    );
  }
  const port = await devtoolsPort(dir);
  if (port == null) {
    return NextResponse.json(
      { error: "instance has no DevTools port (not debuggable)", pages: [] },
      { status: 200, headers: noStore },
    );
  }
  const pages = await listChromePages(port);
  return NextResponse.json({ port, pages }, { headers: noStore });
}
