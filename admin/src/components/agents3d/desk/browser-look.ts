/**
 * Who is using a browser (agent-browser sessions with Chrome running), for the
 * Table: which seat each session goes to and what its little browser window
 * shows. Pure, so the matching and the CPU levels are tested.
 */
import type { BrowserSession } from "@/lib/browsers";

import type { Level } from "./gauge-levels";

/** At most this many unowned windows in the front gap; the rest are counted on the last one. */
export const MAX_UNOWNED = 3;

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
/** The CPU bar is full at two cores. */
const CPU_FULL = 200;

export type BrowserLook = {
  /** Title bar text: the session, marked when nobody owns it. */
  bar: string;
  host: string;
  title: string;
  cpuText: string;
  /** CPU bar fill, 0–1. */
  cpuFill: number;
  level: Level;
  /** More sessions behind this one (shown as "+n"). */
  more: number;
};

export function browserLook(s: BrowserSession, owned: boolean, more = 0): BrowserLook {
  const cpu = s.cpuPercent;
  return {
    bar: owned ? s.session : `unowned · ${s.session}`,
    host: s.page?.host ?? (s.page ? "" : "no page"),
    title: s.page?.title ?? "",
    cpuText: cpu === null ? "CPU …" : `${Math.round(cpu)}% CPU`,
    cpuFill: cpu === null ? 0 : Math.max(0, Math.min(1, cpu / CPU_FULL)),
    level: cpu === null ? "none" : cpu > BROWSER_CPU_BAD ? "bad" : cpu > BROWSER_CPU_WARN ? "warn" : "ok",
    more,
  };
}

/** A window's look as a string: its texture is repainted only when this changes (whole percents). */
export const lookKey = (l: BrowserLook, color: string) => [l.bar, l.host, l.title, l.cpuText, l.level, l.more, color].join("|");
