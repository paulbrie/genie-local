"use client";

import { useEffect, useState } from "react";

import type { BrowserSession, BrowsersResponse } from "@/lib/browsers";
import { BASE_PATH } from "@/lib/config";

const POLL_MS = 5000;

/**
 * The open agent-browser sessions (who is using a browser), from
 * /api/agents3d/browsers every 5 s while `enabled` and the page is visible;
 * the last list is kept through a failed poll. Empty until the first answer.
 */
export function useBrowsers(enabled = true): BrowserSession[] {
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`${BASE_PATH}/api/agents3d/browsers`, { cache: "no-store" });
        if (!res.ok || stop) return;
        const json = (await res.json()) as BrowsersResponse;
        if (!stop) setSessions(json.sessions);
      } catch {
        /* keep the last list */
      }
    };
    const first = setTimeout(() => void load(), 0);
    const iv = setInterval(() => void load(), POLL_MS);
    // Back from a hidden tab: fresh at once, not up to 5 s late.
    const onShow = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      stop = true;
      clearTimeout(first);
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [enabled]);
  return sessions;
}
