"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Agents3DModel, Agents3DResponse, AgentEvent } from "@/lib/agents3d-types";
import { BASE_PATH } from "@/lib/config";

const POLL_MS = 3000;

/**
 * Polls /api/agents3d. Repo layouts are only re-sent when they change, and
 * tool calls only after the newest one we hold, so a busy poll stays small.
 */
export function useAgents3D(hours: number, live: boolean) {
  const [model, setModel] = useState<Agents3DModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cur = useRef<Agents3DModel | null>(null);

  const load = useCallback(async () => {
    const prev = cur.current;
    const q = new URLSearchParams({ hours: String(hours) });
    if (prev) {
      q.set("v", prev.version);
      q.set("rv", prev.reposVersion);
      const newest = Object.values(prev.activity)
        .map((ev) => ev[ev.length - 1]?.t ?? "")
        .sort()
        .pop();
      if (newest) q.set("since", newest);
    }
    try {
      const res = await fetch(`${BASE_PATH}/api/agents3d?${q}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as Agents3DResponse;
      setError(null);
      if ("unchanged" in json) return;
      const activity: Record<string, AgentEvent[]> = {};
      for (const [k, ev] of Object.entries(json.activity)) {
        if (!json.partial || !prev?.activity[k]) {
          activity[k] = ev;
          continue;
        }
        // Merge: drop the overlap at the boundary (same t), then append.
        const old = prev.activity[k];
        const first = ev[0]?.t;
        activity[k] = first ? [...old.filter((e) => e.t < first), ...ev] : old;
      }
      const next: Agents3DModel = {
        version: json.version,
        reposVersion: json.reposVersion,
        comms: json.comms,
        activity,
        repos: json.repos ?? prev?.repos ?? [],
        nodeRepos: json.nodeRepos,
      };
      cur.current = next;
      setModel(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [hours]);

  useEffect(() => {
    cur.current = null;
    const first = setTimeout(() => void load(), 0);
    const poll = live
      ? setInterval(() => {
          if (document.visibilityState === "visible") void load();
        }, POLL_MS)
      : undefined;
    return () => {
      clearTimeout(first);
      clearInterval(poll);
    };
  }, [live, load]);

  return { model, error, reload: load };
}
