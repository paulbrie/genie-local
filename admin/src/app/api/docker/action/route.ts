import { NextResponse } from "next/server";
import { z } from "zod";

import {
  isContainerAction,
  isDockerId,
  isImageAction,
  runContainerAction,
  runImageAction,
} from "@/lib/docker";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  type: z.enum(["container", "image"]),
  id: z.string().refine(isDockerId, "invalid docker id"),
  action: z.string(),
});

/** Run a lifecycle action on a container or image. Auth is enforced by proxy.ts. */
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

  const { type, id, action } = parsed.data;

  if (type === "container") {
    if (!isContainerAction(action)) {
      return NextResponse.json(
        { error: "unsupported container action" },
        { status: 400 },
      );
    }
    const result = await runContainerAction(id, action);
    return NextResponse.json(result, {
      status: result.ok ? 200 : 422,
      headers: { "Cache-Control": "no-store" },
    });
  }

  if (!isImageAction(action)) {
    return NextResponse.json(
      { error: "unsupported image action" },
      { status: 400 },
    );
  }
  const result = await runImageAction(id, action);
  return NextResponse.json(result, {
    status: result.ok ? 200 : 422,
    headers: { "Cache-Control": "no-store" },
  });
}
