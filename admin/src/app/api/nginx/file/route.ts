import { NextResponse } from "next/server";
import { z } from "zod";

import { readNginxFile, writeNginxFile } from "@/lib/nginx-config";

export const dynamic = "force-dynamic";

/** Read one config file's contents. `?path=` is validated in the lib. */
export async function GET(req: Request) {
  const path = new URL(req.url).searchParams.get("path") ?? "";
  const result = await readNginxFile(path);
  if (!result.ok)
    return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}

const bodySchema = z.object({
  path: z.string().min(1),
  // 1 MiB ceiling — real nginx configs are a few KB; this just bounds abuse.
  content: z.string().max(1024 * 1024),
});

/** Save a config file: backup → write → `nginx -t` → reload (or roll back). */
export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid request" },
      { status: 400 },
    );
  }

  const result = await writeNginxFile(parsed.data.path, parsed.data.content);
  return NextResponse.json(result, {
    status: result.ok ? 200 : 422,
    headers: { "Cache-Control": "no-store" },
  });
}
