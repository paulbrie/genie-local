"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { CommsMessage } from "@/lib/claude-comms-parse";
import { formatDateTime } from "@/lib/format";

import type { NodeView } from "./comms-view";
import { type CommitLink, MessageBody, TagBadge } from "./message-body";

const STATE_TEXT: Record<CommsMessage["state"], string> = {
  received: "read by the receiver",
  delivered: "delivered",
  queued: "queued, not read yet",
  sending: "sending",
  failed: "failed",
};

export function MessageSheet({
  message,
  byKey,
  commits,
  onClose,
  container,
}: {
  message: CommsMessage | null;
  byKey: Map<string, NodeView>;
  commits: CommitLink[];
  onClose: () => void;
  /** Portal target, e.g. a fullscreen element (default: body). */
  container?: HTMLElement | null;
}) {
  const [raw, setRaw] = useState(false);
  const from = message ? byKey.get(message.from) : undefined;
  const to = message ? byKey.get(message.to) : undefined;
  return (
    <Sheet open={!!message} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-2xl" container={container ?? undefined}>
        {message && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <NodeName n={from} /> <span className="text-muted-foreground">→</span> <NodeName n={to} />
              </SheetTitle>
              <SheetDescription>
                {message.summary ?? "(no summary)"}
              </SheetDescription>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Sent</dt>
                <dd>{message.sentAt ? formatDateTime(message.sentAt) : "unknown (sender's transcript not found)"}</dd>
                <dt className="text-muted-foreground">Read</dt>
                <dd>{message.receivedAt ? formatDateTime(message.receivedAt) : "—"}</dd>
                <dt className="text-muted-foreground">State</dt>
                <dd>{STATE_TEXT[message.state]}</dd>
                <dt className="text-muted-foreground">Id</dt>
                <dd className="font-mono">{message.id}</dd>
              </dl>
              {(message.tags.length > 0 || message.guess) && (
                <div className="flex flex-wrap gap-1.5">
                  {[...new Set(message.tags.map((t) => t.tag))].map((t) => (
                    <TagBadge key={t} tag={t} />
                  ))}
                  {message.guess && (
                    <Badge variant="outline">guessed: {message.guess}</Badge>
                  )}
                </div>
              )}
              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={() => setRaw(!raw)}
                  className="rounded border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                >
                  {raw ? "Formatted" : "Raw"}
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/20 p-3">
                {raw ? (
                  <pre className="font-mono text-xs whitespace-pre-wrap break-words">{message.body}</pre>
                ) : (
                  <MessageBody body={message.body} commits={commits} />
                )}
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function NodeName({ n }: { n: NodeView | undefined }) {
  if (!n) return <span>?</span>;
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-2.5 rounded-full" style={{ background: n.color }} />
      {n.name}
    </span>
  );
}
