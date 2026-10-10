/**
 * Who is using a browser (agent-browser sessions with Chrome running), for the
 * Table: which seat each session goes to and what its label shows. Pure, so
 * the matching and the CPU levels are tested.
 */
import type { BrowserSession } from "@/lib/browsers";

import type { Level } from "./gauge-levels";

/**
 * Running sessions by the agent at the table they belong to (matched by name,
 * case-insensitive: the session's live agent, else its own name), and the rest
 * (no agent, "default", an agent not seated) as unowned. An agent's sessions
 * busiest first.
 */
export function seatBrowsers(cast: { key: string; name: string }[], sessions: BrowserSession[]): { byAgent: Map<string, BrowserSession[]>; unowned: BrowserSession[] } {
  const keyOf = new Map(cast.map((a) => [a.name.toLowerCase(), a.key]));
  const byAgent = new Map<string, BrowserSession[]>();
  const unowned: BrowserSession[] = [];
  for (const s of sessions) {
    if (!s.running) continue;
    const key = s.unowned ? undefined : keyOf.get((s.agent ?? s.session).toLowerCase());
    if (key === undefined) unowned.push(s);
    else byAgent.set(key, [...(byAgent.get(key) ?? []), s]);
  }
  const busiest = (a: BrowserSession, b: BrowserSession) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) || a.session.localeCompare(b.session);
  for (const list of byAgent.values()) list.sort(busiest);
  unowned.sort(busiest);
  return { byAgent, unowned };
}

/** A browser's CPU (100 = one core): amber over 30 %, red over a whole core. */
export const BROWSER_CPU_WARN = 30;
export const BROWSER_CPU_BAD = 100;

export type BrowserLook = {
  host: string;
  cpuText: string;
  level: Level;
  /** More sessions behind this one (shown as "+n"). */
  more: number;
};

/** A session's label: its page's host, its CPU in whole percents and that level. */
export function browserLook(s: BrowserSession, more = 0): BrowserLook {
  const cpu = s.cpuPercent;
  return {
    host: s.page?.host ?? (s.page ? "" : "no page"),
    cpuText: cpu === null ? "CPU …" : `${Math.round(cpu)}% CPU`,
    level: cpu === null ? "none" : cpu > BROWSER_CPU_BAD ? "bad" : cpu > BROWSER_CPU_WARN ? "warn" : "ok",
    more,
  };
}
