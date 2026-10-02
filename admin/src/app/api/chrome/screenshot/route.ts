import { NextResponse } from "next/server";

import {
  captureChromePage,
  devtoolsPort,
  isValidInstanceDir,
} from "@/lib/chrome";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/**
 * Live JPEG screenshot of what an instance is looking at.
 * `?dir=<user-data-dir>` and optional `?url=<page url>` to pick a tab.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const dir = params.get("dir");
  const url = params.get("url") ?? undefined;
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
      { error: "instance is not debuggable (no DevTools port)" },
      { status: 409, headers: noStore },
    );
  }
  try {
    const image = await captureChromePage(port, url);
    if (image.length === 0) throw new Error("empty screenshot");
    return new NextResponse(new Uint8Array(image), {
      status: 200,
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 502, headers: noStore },
    );
  }
}
