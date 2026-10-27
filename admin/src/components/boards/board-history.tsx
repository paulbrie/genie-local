"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { History, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { BASE_PATH } from "@/lib/config";
import type { BoardDoc } from "@/lib/boards/core.mjs";
import { cn } from "@/lib/utils";
import { confirmDialog } from "@/lib/ask";

export type HistoryEntry = {
  id: number;
  label: string | null;
  authors: string | null;
  changes: number;
  createdAt: string;
};

function when(at: string) {
  const d = new Date(at);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)} h ago`;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function describe(e: HistoryEntry) {
  if (e.label) return e.label;
  const who = e.authors ?? "someone";
  return `${who} · ${e.changes} change${e.changes === 1 ? "" : "s"}`;
}

/**
 * The board's past: a slider over the points it was kept at. Moving it shows
 * the board as it stood then (nobody else sees you looking), and Restore puts
 * everyone back there — itself recorded, so it can be undone in turn.
 */
export function HistoryPanel({
  boardId,
  onPreview,
  onClose,
}: {
  boardId: number;
  /** The doc to show instead of the live one, or null to go back to now. */
  onPreview: (doc: BoardDoc | null, at: HistoryEntry | null) => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [index, setIndex] = useState(-1); // -1 = now
  const [busy, setBusy] = useState(false);
  // Only the newest request may paint, so a dragged slider can't finish backwards.
  const request = useRef(0);

  useEffect(() => {
    let live = true;
    fetch(`${BASE_PATH}/api/boards/${boardId}/history`)
      .then((r) => r.json())
      .then((rows: HistoryEntry[]) => live && setEntries(rows))
      .catch(() => live && setEntries([]));
    return () => {
      live = false;
    };
  }, [boardId]);

  const show = useCallback(
    async (i: number) => {
      setIndex(i);
      if (!entries || i < 0 || i >= entries.length) return onPreview(null, null);
      const entry = entries[i];
      const ticket = ++request.current;
      try {
        const res = await fetch(`${BASE_PATH}/api/boards/${boardId}/history?at=${entry.id}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? res.statusText);
        if (ticket === request.current) onPreview(body.doc, entry);
      } catch (e) {
        toast.error(`Couldn't open that point: ${(e as Error).message}`);
      }
    },
    [boardId, entries, onPreview],
  );

  // Looking at the past ends when the panel does.
  useEffect(() => () => onPreview(null, null), [onPreview]);

  const restore = async () => {
    if (!entries || index < 0) return;
    const entry = entries[index];
    if (!(await confirmDialog(`Put the board back to ${describe(entry)} (${when(entry.createdAt)})? Everyone on it moves back too.`, { confirmLabel: "Put it back" }))) return;
    setBusy(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/boards/${boardId}/history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ at: entry.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      onPreview(null, null);
      onClose();
      toast.success("The board is back to how it was");
    } catch (e) {
      toast.error(`Couldn't restore: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const at = entries && index >= 0 ? entries[index] : null;

  return (
    <aside
      className="absolute bottom-3 left-1/2 z-40 w-[min(640px,calc(100%-24px))] -translate-x-1/2 rounded-xl border bg-background/95 p-3 shadow-xl backdrop-blur"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      data-testid="history-panel"
    >
      <header className="mb-2 flex items-center gap-2">
        <History className="size-4" />
        <span className="text-sm font-semibold">History</span>
        <span className="flex-1 truncate text-xs text-muted-foreground">
          {entries === null
            ? "looking…"
            : entries.length === 0
              ? "Nothing kept yet — points appear as the board is worked on, and before Claude changes anything."
              : at
                ? `${describe(at)} · ${when(at.createdAt)}`
                : "Now"}
        </span>
        {at && (
          <Button size="xs" variant="default" disabled={busy} onClick={restore} data-testid="history-restore">
            <RotateCcw /> Put the board back here
          </Button>
        )}
        <Button size="icon-sm" variant="ghost" title="Close" onClick={onClose}>
          <X />
        </Button>
      </header>

      {!!entries?.length && (
        <>
          <input
            type="range"
            min={0}
            max={entries.length}
            value={index < 0 ? entries.length : index}
            onChange={(e) => {
              const v = Number(e.target.value);
              show(v >= entries.length ? -1 : v);
            }}
            className="w-full accent-blue-600"
            aria-label="Point in the board's history"
            data-testid="history-slider"
          />
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>{when(entries[0].createdAt)}</span>
            <span className={cn(index < 0 && "font-semibold text-foreground")}>now</span>
          </div>
        </>
      )}
    </aside>
  );
}
