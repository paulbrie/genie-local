import { promises as fs } from "node:fs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { boardAssetPath } from "@/lib/boards/assets";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ board: string; file: string }> };

/** A board image. Names are random and never reused, so it caches for good. */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { board, file } = await params;
  const asset = boardAssetPath(board, file);
  if (!asset) return NextResponse.json({ error: "not found" }, { status: 404 });
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(asset.abs);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": asset.mime,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
