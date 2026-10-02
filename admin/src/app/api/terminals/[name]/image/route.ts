import { NextResponse } from "next/server";

import { saveTerminalImage } from "@/lib/terminals";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB — comfortably covers a screenshot

/**
 * Save a clipboard image pasted into a terminal. The browser can't stream binary
 * into tmux, so it POSTs the raw image bytes here (Content-Type = the image MIME);
 * we persist it to a shared temp dir and return its absolute path, which the
 * client then types into the pane for a `claude` session to read. See
 * <TerminalDock>'s pasteFromClipboard and lib/terminals saveTerminalImage.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const mime = (req.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!mime.startsWith("image/")) {
    return NextResponse.json(
      { error: "expected an image body" },
      { status: 415, headers: noStore },
    );
  }
  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.byteLength === 0) {
    return NextResponse.json(
      { error: "empty image" },
      { status: 400, headers: noStore },
    );
  }
  if (bytes.byteLength > MAX_BYTES) {
    return NextResponse.json(
      { error: "image too large (max 20MB)" },
      { status: 413, headers: noStore },
    );
  }
  try {
    const path = await saveTerminalImage(name, bytes, mime);
    return NextResponse.json({ path }, { headers: noStore });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 422, headers: noStore },
    );
  }
}
