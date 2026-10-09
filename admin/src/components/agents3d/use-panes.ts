"use client";

import { useEffect, useRef, useState } from "react";

import { BASE_PATH } from "@/lib/config";

const POLL_MS = 1500;

/** A pane's redacted text; `text: null` means the session has no tmux pane. */
export type PaneView = { pane: string | null; text: string | null; at: string };

/**
 * Polls /api/agents3d/panes for the given agents while `enabled` (live mode,
 * page visible). Unchanged panes come back without text and keep what we have.
 */
export function usePanes(keys: string[], enabled: boolean): Record<string, PaneView> {
  const [panes, setPanes] = useState<Record<string, PaneView>>({});
  const hashes = useRef<Record<string, string>>({});
  const keyStr = keys.join(",");

  useEffect(() => {
    if (!enabled || !keyStr) return;
    let stop = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      const h = Object.entries(hashes.current)
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      try {
        const res = await fetch(`${BASE_PATH}/api/agents3d/panes?keys=${encodeURIComponent(keyStr)}&lines=40&h=${encodeURIComponent(h)}`, {
          cache: "no-store",
        });
        if (!res.ok || stop) return;
        const json = (await res.json()) as {
          panes: Record<string, { pane: string | null; text?: string | null; hash: string | null; at: string; unchanged?: boolean }>;
        };
        setPanes((prev) => {
          const next: Record<string, PaneView> = {};
          for (const [k, p] of Object.entries(json.panes)) {
            if (p.unchanged && prev[k]) next[k] = { ...prev[k], at: p.at };
            else next[k] = { pane: p.pane, text: p.text ?? null, at: p.at };
            if (p.hash) hashes.current[k] = p.hash;
            else delete hashes.current[k];
          }
          return next;
        });
      } catch {
        /* keep the last captures */
      }
    };
    const first = setTimeout(() => void load(), 0);
    const iv = setInterval(() => void load(), POLL_MS);
    return () => {
      stop = true;
      clearTimeout(first);
      clearInterval(iv);
    };
  }, [keyStr, enabled]);

  return panes;
}
