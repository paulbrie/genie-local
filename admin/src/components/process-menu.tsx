"use client";

import { Copy, Scissors, Skull, X } from "lucide-react";
import { toast } from "sonner";

import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { BASE_PATH } from "@/lib/config";

// A process's right-click menu (kill, force kill, kill tree, copy PID) and the kill behind it: the Processes page and
// the Processes widget share them.

export type KillSignal = "SIGTERM" | "SIGKILL";
/** A process, as far as killing it goes. */
export type Killable = { pid: number; name: string };
export type KillFn = (p: Killable, signal: KillSignal, tree: boolean) => void;

type KillResponse = {
  requested: number;
  outcomes: { pid: number; ok: boolean; error?: string }[];
};

/** Send `signal` to `p` (`tree`: and everything under it), saying how it went; `after` once it's done, ok or not. */
export async function killFromUi(
  p: Killable,
  signal: KillSignal,
  tree: boolean,
  after?: () => void,
) {
  const label = tree ? `tree of ${p.name} (${p.pid})` : `${p.name} (${p.pid})`;
  try {
    const res = await fetch(`${BASE_PATH}/api/processes/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid: p.pid, signal, tree }),
    });
    const body: KillResponse = await res.json().catch(() => ({
      requested: p.pid,
      outcomes: [],
    }));
    const ok = body.outcomes.filter((o) => o.ok).length;
    const failed = body.outcomes.filter((o) => !o.ok);
    if (res.ok && failed.length === 0) {
      toast.success(
        `Sent ${signal} to ${label}${ok > 1 ? ` — ${ok} processes` : ""}`,
      );
    } else if (ok > 0) {
      toast.warning(
        `${signal} → ${ok} ok, ${failed.length} failed: ${failed[0]?.error ?? ""}`,
      );
    } else {
      toast.error(
        `Could not ${signal} ${label}: ${failed[0]?.error ?? `HTTP ${res.status}`}`,
      );
    }
  } catch (e) {
    toast.error(`Kill failed: ${(e as Error).message}`);
  } finally {
    after?.();
  }
}

/**
 * The menu's content, inside a ContextMenu whose trigger is the process's row. `label`: what to call it (else its
 * name); `hasChildren: false` turns Kill tree off.
 */
export function ProcessMenu({
  p,
  onKill,
  hasChildren,
  label,
}: {
  p: Killable;
  onKill: KillFn;
  hasChildren?: boolean;
  label?: string;
}) {
  return (
    <ContextMenuContent>
      <ContextMenuLabel className="truncate">
        {label ?? p.name} · {p.pid}
      </ContextMenuLabel>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onKill(p, "SIGTERM", false)}>
        <X /> Kill (SIGTERM)
      </ContextMenuItem>
      <ContextMenuItem
        variant="destructive"
        onClick={() => onKill(p, "SIGKILL", false)}
      >
        <Skull /> Force kill (SIGKILL)
      </ContextMenuItem>
      <ContextMenuItem
        variant="destructive"
        disabled={hasChildren === false}
        onClick={() => onKill(p, "SIGKILL", true)}
      >
        <Scissors /> Force kill tree
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={() => {
          void navigator.clipboard?.writeText(String(p.pid));
          toast.success(`Copied PID ${p.pid}`);
        }}
      >
        <Copy /> Copy PID
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
