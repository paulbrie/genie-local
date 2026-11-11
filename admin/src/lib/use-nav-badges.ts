"use client";

import { useEffect, useState } from "react";
import { useSubject } from "subjecto/react";

import type { WispMotion } from "@/brand/spiridus";
import { BASE_PATH } from "@/lib/config";
import { activeRuns } from "@/store/runs";
import { liveTerminals } from "@/store/terminals";

/**
 * The live counts the navigation shows on its items (the sidebar's pills, the
 * desktop's icon badges): running Chrome instances, running containers and
 * their memory, active agent runs, terminals at work. Polls off the login page,
 * afresh on each navigation, and only while `enabled` (one shell shows at a time).
 */
export function useNavBadges(pathname: string, enabled = true) {
  const [chromeCount, setChromeCount] = useState<number | null>(null);
  const [dockerStats, setDockerStats] = useState<{
    running: number;
    memBytes: number;
  } | null>(null);
  const [runs] = useSubject(activeRuns);
  // Currently-active runs (kept fresh by <RunDock>), shown as sub-items.
  const liveRuns = runs.filter(
    (r) => r.running || r.state === "running" || r.state === "starting",
  );
  const [terms] = useSubject(liveTerminals);
  // "Currently working" = anything not sitting idle at a shell prompt.
  const workingTerms = terms.filter((t) => t.status !== "idle");

  // Live count of running Chrome instances, shown as a badge on the nav item.
  useEffect(() => {
    if (!enabled || pathname === "/login") return;
    let active = true;
    const load = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/chrome`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const json = await res.json();
        if (active) setChromeCount((json.instances ?? []).length);
      } catch {
        /* ignore */
      }
    };
    void load();
    const id = setInterval(load, 7000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [pathname, enabled]);

  // Live running-container count + memory, shown as a badge on the Docker item.
  // `docker stats` is slower than a plain list, so this polls on its own timer.
  useEffect(() => {
    if (!enabled || pathname === "/login") return;
    let active = true;
    const load = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/docker/stats`, {
          cache: "no-store",
        });
        if (!res.ok) {
          if (active) setDockerStats(null);
          return;
        }
        const json = await res.json();
        if (active)
          setDockerStats({
            running: json.running ?? 0,
            memBytes: json.memBytes ?? 0,
          });
      } catch {
        /* ignore */
      }
    };
    void load();
    const id = setInterval(load, 10000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [pathname, enabled]);

  /** The numeric count an item shows, or null. */
  const badgeOf = (href: string): number | null =>
    href === "/chrome" && chromeCount
      ? chromeCount
      : href === "/agents" && liveRuns.length
        ? liveRuns.length
        : href === "/terminals" && workingTerms.length
          ? workingTerms.length
          : href === "/docker" && dockerStats?.running
            ? dockerStats.running
            : null;

  return { dockerStats, liveRuns, workingTerms, badgeOf };
}

/** What useNavBadges gives (app-shell.tsx polls once, for the sidebar and the desktop's icons). */
export type NavBadges = ReturnType<typeof useNavBadges>;

/**
 * The wisp's state (brand motion): looking for you while an agent waits on
 * you, flickering while one works, else idle blinking; a wink on hover.
 */
export function useWispState() {
  const [terms] = useSubject(liveTerminals);
  const waitingOn = terms.filter((t) => t.status === "claude-input").length;
  // (work running in the background after the turn counts as working)
  const working = terms.filter((t) => t.status === "claude-working" || t.status === "claude-background").length;
  const [winking, setWinking] = useState(false);
  const wink = () => {
    if (winking) return;
    setWinking(true);
    setTimeout(() => setWinking(false), 900);
  };
  const motion: WispMotion = winking ? "wink" : waitingOn ? "look" : working ? "flicker" : "blink";
  const title = waitingOn
    ? `${waitingOn} agent${waitingOn === 1 ? " is" : "s are"} waiting for you`
    : working
      ? `${working} agent${working === 1 ? "" : "s"} working`
      : "All quiet";
  return { motion, title, wink };
}
