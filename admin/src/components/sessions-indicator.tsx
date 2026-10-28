"use client";

import { MonitorSmartphone } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { BASE_PATH } from "@/lib/config";
import { formatRelativeTime } from "@/lib/format";
import { Z_GLOBAL_CONTROLS } from "@/lib/z-layers";

type ConnectedSession = {
  key: string;
  current: boolean;
  ip: string | null;
  browser: string;
  userAgent: string | null;
  via: string;
  /** Who, for a Sign in with Genie session; null for the shared admin login. */
  email: string | null;
  since: string;
  lastSeenAt: string;
};

// The heartbeat: a session seen in the last minute counts as connected.
const BEAT_MS = 20_000;

/**
 * Top bar: how many admin sessions are connected right now (a browser with a
 * tab open), and from which browser / IP. Polling it is also this browser's
 * heartbeat.
 */
export function SessionsIndicator() {
  const [sessions, setSessions] = useState<ConnectedSession[] | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    const beat = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/sessions`, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { sessions: ConnectedSession[] };
        if (active) setSessions(json.sessions);
      } catch {
        /* offline: keep the last list */
      }
    };
    void beat();
    const id = setInterval(beat, BEAT_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!sessions) return null;
  const others = sessions.filter((s) => !s.current).length;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={`${sessions.length} admin session${sessions.length === 1 ? "" : "s"} connected`}
        className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-accent/50 hover:text-foreground ${
          others > 0 ? "text-foreground" : "text-muted-foreground"
        }`}
      >
        <MonitorSmartphone className="size-3.5" />
        <span className="tabular-nums">{sessions.length}</span>
        <span className="hidden sm:inline">{sessions.length === 1 ? "session" : "sessions"}</span>
      </button>
      {open && (
        <div
          style={{ zIndex: Z_GLOBAL_CONTROLS }}
          className="absolute top-full right-0 mt-1 w-80 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            Connected now · a tab open in the last minute
          </div>
          <ul className="divide-y">
            {sessions.map((s) => (
              <li key={s.key} className="px-2 py-1.5 text-xs" title={s.userAgent ?? undefined}>
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{s.email ?? s.browser}</span>
                  {s.current && (
                    <span className="shrink-0 rounded bg-primary/10 px-1 text-[10px] text-primary">this browser</span>
                  )}
                  {s.via === "token" && (
                    <span
                      className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground"
                      title="Its cookie wasn't issued by the login form here (an older login, or a token from npm run session)"
                    >
                      token
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex gap-2 text-muted-foreground">
                  {s.email && <span className="truncate">{s.browser}</span>}
                  <span className="font-mono">{s.ip ?? "unknown IP"}</span>
                  <span>· since {formatRelativeTime(s.since)}</span>
                  <span className="ml-auto">seen {formatRelativeTime(s.lastSeenAt)}</span>
                </div>
              </li>
            ))}
          </ul>
          <Link
            href="/logins"
            onClick={() => setOpen(false)}
            className="mt-1 block rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          >
            Login log and all sessions →
          </Link>
        </div>
      )}
    </div>
  );
}
