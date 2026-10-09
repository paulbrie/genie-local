import { NextResponse } from "next/server";

import { captureChromePage, findInstance } from "@/lib/chrome";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/**
 * Live JPEG screenshot of what an instance is looking at.
 * `?dir=<user-data-dir>` and optional `?url=<page url>` to pick a tab.
 * 404: the instance is gone; 409: it has no DevTools port (and why); 502: the
 * capture failed. Errors are JSON `{ error }`.
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
  const inst = await findInstance(dir);
  if (!inst) {
    return NextResponse.json(
      { error: "the instance is no longer running" },
      { status: 404, headers: noStore },
    );
  }
  if (inst.devtoolsPort == null) {
    return NextResponse.json(
      { error: inst.notViewable ?? "no DevTools port: can't be viewed" },
      { status: 409, headers: noStore },
    );
  }
  try {
    const image = await captureChromePage(inst.devtoolsPort, url);
    if (image.length === 0) throw new Error("empty screenshot");
    return new NextResponse(new Uint8Array(image), {
      status: 200,
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `capture failed: ${(e as Error).message.split("\n")[0]}` },
      { status: 502, headers: noStore },
    );
  }
}
