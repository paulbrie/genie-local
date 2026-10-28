// GET /api/files/raw?path=…[&download=1][&confirm=1][&project=<slug>]: a file streamed (never read whole into memory), inline for the
// preview of an image or a PDF, or as a download. A credential file goes out only as a download the page confirmed
// (T243), and every download of one is in the audit log.
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";

import { isPseudo, resolveExisting, scopeRoots } from "@/lib/files/guard";
import { isSecretPath } from "@/lib/files/listing";
import { audit } from "@/lib/files/ops";
import { errorResponse, whoOf } from "../shared";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".avif": "image/avif", ".ico": "image/x-icon", ".pdf": "application/pdf",
};

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  try {
    const t = await resolveExisting(q.get("path") ?? "", scopeRoots(q.get("project")));
    if (isPseudo(t.abs)) return NextResponse.json({ error: "a kernel file (/proc, /sys): not read from here" }, { status: 403 });
    const st = await fs.stat(t.abs);
    if (!st.isFile()) return NextResponse.json({ error: "not a regular file" }, { status: 400 });
    const secret = isSecretPath(t.abs), download = q.get("download") === "1";
    if (secret && !(download && q.get("confirm") === "1")) return NextResponse.json({ error: "a credential file: download it, with a confirm" }, { status: 403 });
    const type = TYPES[path.extname(t.abs).toLowerCase()];
    // (inline only for an image or a PDF; an SVG is served as a download to keep its scripts off this origin)
    const inline = !download && !!type && type !== "image/svg+xml";
    if (download) audit("download", { path: t.abs, bytes: st.size, secret }, whoOf(req));
    const stream = Readable.toWeb(createReadStream(t.abs)) as ReadableStream;
    return new Response(stream, {
      headers: {
        "Content-Type": inline ? type : "application/octet-stream",
        "Content-Length": String(st.size),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(path.basename(t.abs))}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
