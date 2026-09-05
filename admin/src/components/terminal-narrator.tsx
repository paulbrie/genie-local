"use client";

import { useEffect, useRef } from "react";
import { useSubject } from "subjecto/react";

import { BASE_PATH } from "@/lib/config";
import { say } from "@/lib/tts";
import { liveTerminals, type TermStatus } from "@/store/terminals";
import { hydrateVoice, voice } from "@/store/voice";

/**
 * "Jarvis mode" — an ambient narrator that supervises EVERY live terminal at once
 * and speaks natural, non-repetitive updates as work happens. Renders nothing.
 *
 * How it stays cheap and calm while watching many popups:
 *  - It rides the app-wide `liveTerminals` poll (driven by <TerminalDock>, ~5s),
 *    so it sees all sessions on every page, even minimized ones.
 *  - A CHEAP client-side gate (no LLM) decides which terminals are worth a word,
 *    purely from status transitions + token growth — no per-poll model calls.
 *  - Only the changed terminals are batched into ONE /api/narrate call, which
 *    runs headless Claude (Haiku) via the server's CLI and returns 0..N one-liners.
 *  - Speech queues (never `interrupt`), so multiple terminals don't talk over each
 *    other; utterances are spoken highest-priority first.
 *  - A Web Locks leader election means only ONE browser tab narrates.
 *
 * When Jarvis is on, <TerminalVoiceMonitor>'s fixed-phrase alerts stand down.
 */

const API = `${BASE_PATH}/api/narrate`;

// Minimum gap between narrate calls (batches churn instead of firing every poll).
const MIN_CALL_INTERVAL_MS = 8_000;
// A Claude session must grow this many tokens, and this long must pass, before we
// consider an in-progress "still working" update worth a call.
const PROGRESS_TOKEN_DELTA = 4_000;
const PROGRESS_COOLDOWN_MS = 45_000;
// How many recent lines we send back so Jarvis avoids repeating itself.
const RECENT_MAX = 12;

const isWorking = (s: TermStatus) => s === "claude-working" || s === "busy";
const isRest = (s: TermStatus) => s === "idle" || s === "claude-idle";

type Mem = {
  status: TermStatus;
  workingLatch: boolean; // has been working since we last resolved it
  progressTokens: number; // token total at the last progress/turn boundary
  lastProgressAt: number;
};

type Change = {
  name: string;
  status: TermStatus;
  event: "needs-input" | "finished" | "progress";
  tokensTotal: number;
};

const PRIORITY_WEIGHT: Record<string, number> = { high: 0, normal: 1, low: 2 };

export function TerminalNarrator() {
  const [list] = useSubject(liveTerminals);
  const [cfg] = useSubject(voice);

  // Read settings inside the poll-driven effect without re-running detection when
  // a setting toggles (mirrors <TerminalVoiceMonitor>).
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const mem = useRef(new Map<string, Mem>());
  const pending = useRef(new Map<string, Change>()); // keyed by name; newest wins
  const recentlySaid = useRef<string[]>([]);
  const inFlight = useRef(false);
  const lastCallAt = useRef(0);

  // Web Locks leader election: exactly one tab holds the lock and narrates. Tabs
  // without the API act alone (single-tab fallback).
  const isLeader = useRef(false);
  useEffect(() => {
    hydrateVoice();
    if (typeof navigator === "undefined" || !navigator.locks) {
      isLeader.current = true;
      return;
    }
    const ctrl = new AbortController();
    navigator.locks
      .request("admin-jarvis-narrator", { signal: ctrl.signal }, () => {
        isLeader.current = true;
        // Hold the lock until this tab unmounts (abort releases it).
        return new Promise<void>(() => {});
      })
      .catch(() => {});
    return () => {
      isLeader.current = false;
      ctrl.abort();
    };
  }, []);

  useEffect(() => {
    const active =
      cfgRef.current.enabled &&
      cfgRef.current.jarvis &&
      isLeader.current &&
      typeof window !== "undefined";

    const now = Date.now();
    const seen = new Set<string>();

    for (const t of list) {
      seen.add(t.name);
      const tokens = t.tokens?.total ?? 0;
      const prev = mem.current.get(t.name);

      // First sighting: record a baseline and say nothing, so opening the app with
      // sessions already mid-flight doesn't trigger a backlog of announcements.
      if (!prev) {
        mem.current.set(t.name, {
          status: t.status,
          workingLatch: isWorking(t.status),
          progressTokens: tokens,
          lastProgressAt: now,
        });
        continue;
      }

      let event: Change["event"] | null = null;
      if (t.status !== prev.status) {
        if (t.status === "claude-input") event = "needs-input";
        else if (isRest(t.status) && prev.workingLatch) event = "finished";
        // (working/busy starts are intentionally silent — too noisy.)
      }
      if (
        !event &&
        t.status === "claude-working" &&
        tokens - prev.progressTokens >= PROGRESS_TOKEN_DELTA &&
        now - prev.lastProgressAt >= PROGRESS_COOLDOWN_MS
      ) {
        event = "progress";
      }

      // Advance the baseline regardless of whether we're active, so toggling Jarvis
      // on later never replays transitions that happened while it was off.
      const workingLatch = isWorking(t.status)
        ? true
        : t.status === "claude-input" || isRest(t.status)
          ? false
          : prev.workingLatch;
      const boundary =
        event === "progress" ||
        event === "finished" ||
        (isWorking(t.status) && !isWorking(prev.status));
      mem.current.set(t.name, {
        status: t.status,
        workingLatch,
        progressTokens: boundary ? tokens : prev.progressTokens,
        lastProgressAt: boundary ? now : prev.lastProgressAt,
      });

      // Only queue the events worth speaking; a bare "started working" is skipped.
      if (active && event) {
        pending.current.set(t.name, {
          name: t.name,
          status: t.status,
          event,
          tokensTotal: tokens,
        });
      }
    }

    // Forget sessions that no longer exist so the maps can't grow unbounded.
    for (const name of mem.current.keys()) {
      if (!seen.has(name)) mem.current.delete(name);
    }
    for (const name of pending.current.keys()) {
      if (!seen.has(name)) pending.current.delete(name);
    }

    if (
      !active ||
      inFlight.current ||
      pending.current.size === 0 ||
      now - lastCallAt.current < MIN_CALL_INTERVAL_MS
    ) {
      return;
    }

    // Drain the batch and ask Jarvis. One call covers all changed terminals.
    const changes = [...pending.current.values()];
    pending.current.clear();
    inFlight.current = true;
    lastCallAt.current = now;
    const cfgNow = cfgRef.current;

    void (async () => {
      try {
        const res = await fetch(API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            changes,
            recentlySaid: recentlySaid.current,
          }),
        });
        const json: {
          utterances?: { name: string; text: string; priority?: string }[];
        } = await res.json();
        const utterances = (json.utterances ?? [])
          .filter((u) => u.text?.trim())
          .sort(
            (a, b) =>
              (PRIORITY_WEIGHT[a.priority ?? "normal"] ?? 1) -
              (PRIORITY_WEIGHT[b.priority ?? "normal"] ?? 1),
          );
        for (const u of utterances) {
          // Never interrupt: queue so several terminals are heard in turn.
          say(u.text, cfgNow, { interrupt: false });
          recentlySaid.current.push(u.text);
        }
        if (recentlySaid.current.length > RECENT_MAX) {
          recentlySaid.current = recentlySaid.current.slice(-RECENT_MAX);
        }
      } catch {
        /* transient — the events are gone, but new ones will re-trigger */
      } finally {
        inFlight.current = false;
      }
    })();
  }, [list]);

  return null;
}
