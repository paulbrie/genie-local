"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { useSubject } from "subjecto/react";

import { BASE_PATH } from "@/lib/config";
import { formatBytes } from "@/lib/format";
import type { ProjectMemoryStatus } from "@/lib/project-memory";
import { say } from "@/lib/tts";
import { projectMemory } from "@/store/project-memory";
import { voice } from "@/store/voice";

const POLL_MS = 5000;
/** A hidden tab still warns, just looks less often. */
const HIDDEN_POLL_MS = 20_000;
/** The server warns when less than this share of its memory is left. */
const SERVER_LOW = 0.1;
/** Once warned, a project (or the server) is quiet again until it's back under this share of its limit. */
const REARM = 0.9;

/**
 * Keeps the projects' memory reading fresh for the whole app (store/project-memory)
 * and warns, with a toast and, when voice alerts are on, out loud, when a project
 * passes its limit or the server runs low. Mounted once in the root layout.
 */
export function ProjectMemoryMonitor() {
  const pathname = usePathname();
  const [cfg] = useSubject(voice);
  const cfgRef = useRef(cfg);
  useEffect(() => {
    cfgRef.current = cfg;
  }, [cfg]);
  // what's been warned about, so each crossing is said once
  const warned = useRef(new Set<string>());

  const off = pathname === "/login";
  useEffect(() => {
    if (off) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const warn = (key: string, over: boolean, under: boolean, text: string) => {
      if (over && !warned.current.has(key)) {
        warned.current.add(key);
        toast.warning(text, { duration: 15_000 });
        if (cfgRef.current.enabled) say(text, cfgRef.current);
      } else if (under) warned.current.delete(key);
    };
    const check = (s: ProjectMemoryStatus) => {
      for (const p of s.projects) {
        const limit = s.limits[p.slug];
        if (!limit) continue;
        const bytes = limit * 1024 * 1024;
        warn(`p:${p.slug}`, p.bytes > bytes, p.bytes < bytes * REARM, `${p.slug} is using ${formatBytes(p.bytes)} of memory, over its ${formatBytes(bytes)} limit`);
      }
      // (a project that stopped is under its limit again)
      for (const key of warned.current)
        if (key.startsWith("p:") && !s.projects.some((p) => `p:${p.slug}` === key)) warned.current.delete(key);
      const { totalBytes, availableBytes } = s.server;
      if (totalBytes)
        warn(
          "server",
          availableBytes < totalBytes * SERVER_LOW,
          availableBytes > totalBytes * SERVER_LOW * (2 - REARM),
          `The server is low on memory: ${formatBytes(availableBytes)} left of ${formatBytes(totalBytes)}`,
        );
    };
    const load = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/project-memory`, { cache: "no-store" });
        if (res.ok && live) {
          const s: ProjectMemoryStatus = await res.json();
          projectMemory.next(s);
          check(s);
        }
      } catch {
        /* the admin is restarting, or the box is busy: the next look will tell */
      }
      if (live) timer = setTimeout(load, document.hidden ? HIDDEN_POLL_MS : POLL_MS);
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [off]);

  return null;
}
