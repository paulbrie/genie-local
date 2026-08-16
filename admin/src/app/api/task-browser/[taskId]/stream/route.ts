import WebSocket from "ws";

import { getStreamPort } from "@/lib/task-browser";

// Must run on the Node runtime (uses `ws` + Buffer + a long-lived stream).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BOUNDARY = "abframe";

/**
 * Live viewport of a task's browser as a motion-JPEG stream.
 *
 * Renders directly in an <img src=…>. We connect (server-side) to the task
 * session's localhost WebSocket, decode each `{type:"frame"}` message's base64
 * JPEG, and re-emit it as a `multipart/x-mixed-replace` part.
 *
 * `X-Accel-Buffering: no` tells Nginx not to buffer the response, so frames
 * reach the browser as they arrive (the `/admin` proxy already forwards this).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  const port = await getStreamPort(taskId);
  if (!port) {
    return new Response("browser stream unavailable — open a URL first", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const encoder = new TextEncoder();
  let ws: WebSocket | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      ws = new WebSocket(`ws://127.0.0.1:${port}/?maxFps=12`);
      let last: Buffer | null = null;
      let sinceEmit = 0;

      const emit = (jpeg: Buffer): boolean => {
        const header =
          `--${BOUNDARY}\r\n` +
          `Content-Type: image/jpeg\r\n` +
          `Content-Length: ${jpeg.length}\r\n\r\n`;
        try {
          controller.enqueue(encoder.encode(header));
          controller.enqueue(jpeg);
          controller.enqueue(encoder.encode("\r\n"));
          sinceEmit = 0;
          return true;
        } catch {
          return false; // consumer gone
        }
      };

      ws.on("message", (raw: WebSocket.RawData) => {
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        const frame = msg as { type?: string; data?: string };
        if (frame.type !== "frame" || typeof frame.data !== "string") return;

        last = Buffer.from(frame.data, "base64");
        if (!emit(last)) ws?.close();
      });

      // A browser <img> only commits an MJPEG part once the *next* boundary
      // arrives. A static page sends a single frame and then nothing, so without
      // a follow-up the view would stay blank. Re-emit the latest frame when the
      // stream has been quiet — cheap, and keeps the first frame from getting
      // stuck. (~2 fps floor; live changes still stream at full rate.)
      heartbeat = setInterval(() => {
        sinceEmit += 1;
        if (last && sinceEmit >= 1 && !emit(last)) ws?.close();
      }, 500);

      const end = () => {
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      ws.on("close", end);
      ws.on("error", end);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      ws?.close();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
      Pragma: "no-cache",
    },
  });
}
