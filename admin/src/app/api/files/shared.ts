// Shared bits of the /api/files routes (T243): who acts (for the audit lines), and errors as JSON.
import { NextRequest, NextResponse } from "next/server";

import { PathError } from "@/lib/files/guard";
import { UploadError } from "@/lib/files/uploads";

/** the admin (one login) and where the request came from, for the audit lines */
export function whoOf(req: NextRequest): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
  return `admin@${ip}`;
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof PathError || err instanceof UploadError) {
    return NextResponse.json({ error: err.message, ...(err instanceof UploadError && err.received !== undefined ? { received: err.received } : {}) }, { status: err.status });
  }
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM") return NextResponse.json({ error: "permission denied (the admin runs as genie)" }, { status: 403 });
  if (code === "ENOENT") return NextResponse.json({ error: "not found" }, { status: 404 });
  if (code === "ENOTEMPTY" || code === "EEXIST") return NextResponse.json({ error: "already exists" }, { status: 409 });
  console.error("[files] error:", err instanceof Error ? err.message : String(err));
  return NextResponse.json({ error: err instanceof Error ? err.message : "failed" }, { status: 500 });
}
