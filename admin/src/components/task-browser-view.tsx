"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Globe, MousePointerClick, RefreshCw } from "lucide-react";

import { BASE_PATH } from "@/lib/config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Live view of a task's agent-browser session, streamed as MJPEG into an <img>.
 *
 * Drop it anywhere a task is in scope: <TaskBrowserView taskId={task.id} />.
 * "Open" launches/navigates the task's isolated browser; the image then shows
 * whatever that browser is doing — including actions an automation drives on the
 * same session. Clicking the image forwards a real click into the browser.
 */
export function TaskBrowserView({
  taskId,
  defaultUrl = "https://example.com",
}: {
  taskId: string;
  defaultUrl?: string;
}) {
  const api = `${BASE_PATH}/api/task-browser/${encodeURIComponent(taskId)}`;
  const [url, setUrl] = useState(defaultUrl);
  const [streaming, setStreaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [clickable, setClickable] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // Cache-busting token forces the <img> to reconnect a fresh MJPEG stream.
  const [nonce, setNonce] = useState(0);
  const streamSrc = streaming ? `${api}/stream?t=${nonce}` : undefined;

  // A freshly-launched session may not paint its first frame before the stream
  // connects (nothing has changed yet for CDP to screencast). Retry a few times
  // until a frame lands so the viewer is never stuck blank.
  const retriesRef = useRef(0);
  const MAX_RETRIES = 4;

  useEffect(() => {
    if (!streaming) return;
    const id = setTimeout(() => {
      if (connecting && retriesRef.current < MAX_RETRIES) {
        retriesRef.current += 1;
        setNonce((n) => n + 1);
      }
    }, 3500);
    return () => clearTimeout(id);
  }, [streaming, nonce, connecting]);

  const open = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`${api}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error ?? "failed to open");
      retriesRef.current = 0;
      setConnecting(true);
      setStreaming(true);
      setNonce((n) => n + 1);
    } catch (e) {
      toast.error(`Browser: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [api, url]);

  const onImageClick = useCallback(
    async (e: React.MouseEvent<HTMLImageElement>) => {
      if (!clickable) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top) / rect.height;
      try {
        const res = await fetch(`${api}/click`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nx, ny }),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "click failed");
      } catch (err) {
        toast.error(`Click: ${(err as Error).message}`);
      }
    },
    [api, clickable],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Globe className="size-4 shrink-0 text-muted-foreground" />
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && open()}
          placeholder="https://…"
          spellCheck={false}
          className="font-mono text-sm"
        />
        <Button onClick={open} disabled={busy}>
          {busy ? "Opening…" : streaming ? "Go" : "Open"}
        </Button>
        {streaming && (
          <>
            <Button
              variant="outline"
              size="icon"
              title="Reconnect stream"
              onClick={() => {
                retriesRef.current = 0;
                setConnecting(true);
                setNonce((n) => n + 1);
              }}
            >
              <RefreshCw className="size-4" />
            </Button>
            <Button
              variant={clickable ? "default" : "outline"}
              size="icon"
              title={clickable ? "Click-to-interact: ON" : "Click-to-interact: OFF"}
              onClick={() => setClickable((c) => !c)}
            >
              <MousePointerClick className="size-4" />
            </Button>
          </>
        )}
      </div>

      <div
        className="relative overflow-hidden rounded-md border bg-muted"
        style={{ aspectRatio: "1280 / 720" }}
      >
        {streamSrc ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={streamSrc}
              alt="Task browser live view"
              onClick={onImageClick}
              onLoad={() => setConnecting(false)}
              onError={() => {
                if (retriesRef.current < MAX_RETRIES) {
                  retriesRef.current += 1;
                  setNonce((n) => n + 1);
                }
              }}
              className={`size-full object-contain ${clickable ? "cursor-crosshair" : ""}`}
            />
            {connecting && (
              <div className="absolute inset-0 grid place-items-center bg-muted/60 text-sm text-muted-foreground">
                Connecting to browser…
              </div>
            )}
          </>
        ) : (
          <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
            Open a URL to start the live browser view.
          </div>
        )}
      </div>
    </div>
  );
}
