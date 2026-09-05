"use client";

import { useEffect, useRef } from "react";
import { useSubject } from "subjecto/react";

import { say } from "@/lib/tts";
import { liveTerminals, type TermStatus } from "@/store/terminals";
import { hydrateVoice, voice } from "@/store/voice";

/**
 * Speaks aloud when a terminal changes state, so you don't have to watch it:
 *
 *  - a terminal that was working drops to idle  → "<name> finished"
 *  - a Claude session blocks on a prompt         → "<name> is asking a question"
 *
 * Renders nothing. Mounted once in the root layout, it rides the app-wide
 * `liveTerminals` poll (driven by <TerminalDock>), so alerts fire on every page —
 * and even while the tab is in the background — not just on the Terminals page.
 */

type Cat = "working" | "asking" | "rest";

function categorize(s: TermStatus): Cat {
  if (s === "claude-input") return "asking"; // blocked on a question/approval
  if (s === "claude-working" || s === "busy") return "working";
  return "rest"; // "idle" | "claude-idle" — sitting at a prompt
}

// Per-terminal memory across polls. `workingLatch` = the terminal has been busy
// since we last spoke about it, so the next drop to a resting state is a genuine
// "finished" (not just an already-idle terminal that we started watching).
type Mem = { cat: Cat; workingLatch: boolean };

export function TerminalVoiceMonitor() {
  const [list] = useSubject(liveTerminals);
  const [cfg] = useSubject(voice);
  const mem = useRef(new Map<string, Mem>());
  // Read the latest settings inside the poll-driven effect without making it
  // re-run (and possibly re-announce) every time a setting changes.
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  useEffect(() => {
    hydrateVoice();
  }, []);

  useEffect(() => {
    const cfgNow = cfgRef.current;
    const { enabled, jarvis } = cfgNow;
    // In Jarvis mode the LLM narrator (<TerminalNarrator>) does the talking, so
    // the fixed-phrase alerts stand down — but we keep updating `mem` below so
    // toggling Jarvis off doesn't replay a backlog of transitions.
    const speakAlerts = enabled && !jarvis;
    const seen = new Set<string>();

    for (const t of list) {
      seen.add(t.name);
      const cat = categorize(t.status);
      const prev = mem.current.get(t.name);

      // First sighting: record a baseline and stay silent, so a page load with
      // already-idle (or already-asking) sessions doesn't announce anything.
      if (!prev) {
        mem.current.set(t.name, { cat, workingLatch: cat === "working" });
        continue;
      }

      if (speakAlerts && cat !== prev.cat) {
        if (cat === "asking") {
          say(`${t.name} is asking a question`, cfgNow);
        } else if (cat === "rest" && prev.workingLatch) {
          say(`${t.name} finished`, cfgNow);
        }
      }

      // Latch on when working; clear it once we've reached a state we announce
      // (or would announce), so nothing repeats until real work happens again.
      // We update this even when disabled, so toggling on never replays a
      // backlog of transitions that happened while it was off.
      let workingLatch = prev.workingLatch;
      if (cat === "working") workingLatch = true;
      else if (cat === "asking" || cat === "rest") workingLatch = false;

      mem.current.set(t.name, { cat, workingLatch });
    }

    // Forget sessions that no longer exist so the map can't grow unbounded.
    for (const name of mem.current.keys()) {
      if (!seen.has(name)) mem.current.delete(name);
    }
  }, [list]);

  return null;
}
