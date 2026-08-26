import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { MAX_DIAGRAM_BYTES } from "@/lib/diagrams";
import { validateMermaid } from "@/lib/mermaid-validate";

export const dynamic = "force-dynamic";

const schema = z.object({ source: z.string().max(MAX_DIAGRAM_BYTES) });

/**
 * Validate Mermaid source without saving. The agent-facing pre-flight check:
 * POST `{ source }` → `{ ok, error?, line?, diagramType? }`. Auth via proxy.ts
 * (session cookie, or the diagrams x-api-key). Always HTTP 200 — `ok` carries
 * the verdict so a syntax error isn't mistaken for a transport failure.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const result = await validateMermaid(parsed.data.source);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
