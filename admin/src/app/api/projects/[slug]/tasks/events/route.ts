// GET: a server-sent event stream of the project's task changes (tasks,
// comments, files), so an open board refreshes as soon as anything changes:
// the UI in another tab, or Claude through the local-genie MCP.
import { NextRequest, NextResponse } from "next/server";

import { getProjectIdBySlug } from "@/lib/data";
import { requireAdmin } from "@/lib/require-admin";
import { subscribeTaskChanges } from "@/lib/task-events";

export const dynamic = "force-dynamic";

// Under nginx's 300 s proxy_read_timeout, so idle streams stay open.
const HEARTBEAT_MS = 25_000;

type Ctx = { params: Promise<{ slug: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const projectId = await getProjectIdBySlug((await params).slug);
  if (projectId == null) {
    return NextResponse.json({ error: "no such project" }, { status: 404 });
  }

  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          cleanup(); // stream already closed
        }
      };
      const unsubscribe = subscribeTaskChanges(
        projectId,
        (c) => send(`data: ${JSON.stringify(c)}\n\n`),
        () => send(`event: resync\ndata: {}\n\n`),
      );
      const heartbeat = setInterval(() => send(`: ping\n\n`), HEARTBEAT_MS);
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      send(`: connected\n\n`);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
