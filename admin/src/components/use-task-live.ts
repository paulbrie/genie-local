"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { BASE_PATH } from "@/lib/config";

// Bursts (a reorder updates every task) collapse into one refresh.
const DEBOUNCE_MS = 300;

/**
 * Keep the page in step with the project's tasks: subscribe to the server's
 * task-change stream and refresh the page's data on every change, whoever made
 * it (another tab, or Claude through the MCP). While `busy()` (a drag in
 * progress) refreshes wait; call `flush()` when it's over.
 */
export function useTaskLive(slug: string, busy: () => boolean) {
  const router = useRouter();
  const [live, setLive] = useState(false);
  const pending = useRef(false);
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  });

  const flush = useCallback(() => {
    if (!pending.current) return;
    pending.current = false;
    router.refresh();
  }, [router]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hadError = false;
    const schedule = () => {
      pending.current = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!busyRef.current()) flush();
      }, DEBOUNCE_MS);
    };
    // EventSource reconnects by itself after a drop.
    const es = new EventSource(
      `${BASE_PATH}/api/projects/${encodeURIComponent(slug)}/tasks/events`,
    );
    es.onopen = () => {
      setLive(true);
      // Back after a drop: changes may have been missed meanwhile.
      if (hadError) schedule();
      hadError = false;
    };
    es.onerror = () => {
      setLive(false);
      hadError = true;
    };
    es.onmessage = schedule;
    es.addEventListener("resync", schedule);
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [slug, flush]);

  return { live, flush };
}
