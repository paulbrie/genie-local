"use client";

import { useState, useSyncExternalStore } from "react";

import { Tabs } from "@/components/ui/tabs";

// Same-tab writes don't fire `storage`, so notify subscribers ourselves.
const CHANGE_EVENT = "admin:project-tab";

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked
  }
}

/**
 * The project page's tabs, remembering the last one opened per project in
 * localStorage. A `forced` tab (from `?tab=`, e.g. a Comms link into the git
 * history) wins over the remembered one.
 */
export function ProjectTabs({
  slug,
  tabs,
  forced,
  children,
}: {
  slug: string;
  tabs: string[];
  forced?: string;
  children: React.ReactNode;
}) {
  const storageKey = `admin:project-tab:${slug}`;
  // null on the server and during hydration, then the stored value.
  const stored = useSyncExternalStore(
    subscribe,
    () => readStored(storageKey),
    () => null,
  );
  // A tab clicked on this page beats `forced`, which only picks the first one.
  const [picked, setPicked] = useState<string | null>(null);
  const tab =
    [picked, forced, stored].find(
      (t): t is string => !!t && tabs.includes(t),
    ) ?? tabs[0];

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => {
        const next = String(v);
        setPicked(next);
        try {
          localStorage.setItem(storageKey, next);
        } catch {
          /* storage blocked: the tab won't be remembered */
        }
        window.dispatchEvent(new Event(CHANGE_EVENT));
      }}
    >
      {children}
    </Tabs>
  );
}
