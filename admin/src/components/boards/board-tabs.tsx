"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LayoutGrid, Plus, X } from "lucide-react";
import { Subject } from "subjecto";
import { useSubject } from "subjecto/react";

import { BASE_PATH } from "@/lib/config";
import { cn } from "@/lib/utils";
import { noteBoardOpened, syncRecentBoards } from "@/store/recent-boards";

/** The boards kept open as tabs, in order, on this browser. */
const KEY = "boards.tabs";

type Summary = { id: number; title: string };

/**
 * The board on screen, as its live connection knows it: its current name (a
 * rename by anyone shows at once), whether it's connected, and how to rename
 * it. Its tab shows all three, in place of a title bar on the board.
 */
export type OpenBoard = { id: number; title: string; status: string; rename: () => void };
export const openBoard = new Subject<OpenBoard | null>(null, { name: "boards.open" });

function loadTabs(): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((n) => Number.isInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}
const saveTabs = (ids: number[]) => localStorage.setItem(KEY, JSON.stringify(ids));

/**
 * Tabs across the top of a board, one per board kept open, to go between a few
 * boards in a click. Opening a board adds its tab; × (or a middle click) closes
 * one; + offers the rest. Titles come from the board list, refreshed when the
 * window comes back into focus, so a rename elsewhere shows up.
 */
export function BoardTabs({ current, title }: { current: number; title: string }) {
  const router = useRouter();
  const [tabs, setTabs] = useState<number[]>([current]);
  const [boards, setBoards] = useState<Summary[] | null>(null);
  // the + menu, open at this point (fixed: the tab strip scrolls, and clips)
  const [adding, setAdding] = useState<{ x: number; y: number } | null>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const [live] = useSubject(openBoard);
  const here = live?.id === current ? live : null;

  useEffect(() => {
    const saved = loadTabs();
    const next = saved.includes(current) ? saved : [...saved, current];
    saveTabs(next);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after mount
    setTabs(next);
  }, [current]);

  useEffect(() => {
    let live = true;
    const refresh = () =>
      fetch(`${BASE_PATH}/api/boards`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((list: Summary[] | null) => {
          if (!live || !Array.isArray(list)) return;
          setBoards(list);
          syncRecentBoards(list);
          // a board archived or deleted since loses its tab
          const known = new Set(list.map((b) => b.id));
          setTabs((t) => {
            const kept = t.filter((id) => id === current || known.has(id));
            if (kept.length !== t.length) saveTabs(kept);
            return kept;
          });
        })
        .catch(() => {});
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
    };
  }, [current]);

  useEffect(() => {
    if (!adding) return;
    const close = (e: PointerEvent) => {
      if (!addRef.current?.contains(e.target as Node)) setAdding(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [adding]);

  const titles = useMemo(() => {
    const m = new Map((boards ?? []).map((b) => [b.id, b.title]));
    m.set(current, here?.title || (m.get(current) ?? title));
    return m;
  }, [boards, current, title, here?.title]);

  // (the sidebar lists the boards last opened here, under its current name)
  const currentTitle = titles.get(current) ?? title;
  useEffect(() => noteBoardOpened(current, currentTitle), [current, currentTitle]);

  const close = (id: number) => {
    const i = tabs.indexOf(id);
    const next = tabs.filter((t) => t !== id);
    saveTabs(next);
    setTabs(next);
    if (id === current) {
      const to = next[Math.min(i, next.length - 1)];
      router.push(to ? `/boards/${to}` : "/boards");
    }
  };

  const others = (boards ?? []).filter((b) => !tabs.includes(b.id));

  return (
    <nav className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b bg-muted/40 px-2 pt-1" data-testid="board-tabs">
      <Link href="/boards" title="All boards" className="mb-1 mr-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
        <LayoutGrid className="size-4" />
      </Link>
      {tabs.map((id) => (
        <div
          key={id}
          className={cn(
            "group flex h-8 shrink-0 items-center whitespace-nowrap rounded-t-md border border-b-0 text-sm",
            id === current ? "bg-background font-medium" : "border-transparent text-muted-foreground hover:bg-background/60",
          )}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              close(id);
            }
          }}
        >
          <Link
            href={`/boards/${id}`}
            className="py-1 pl-3 pr-1"
            title={id === current ? "Double-click to rename" : titles.get(id)}
            onDoubleClick={id === current ? () => here?.rename() : undefined}
            data-testid={id === current ? "board-title" : undefined}
          >
            {titles.get(id) ?? "…"}
          </Link>
          {id === current && here && (
            <span
              className={cn(
                "mx-1 size-2 shrink-0 rounded-full",
                here.status === "live" ? "bg-emerald-500" : here.status === "connecting" ? "animate-pulse bg-amber-500" : "bg-red-500",
              )}
              title={here.status === "live" ? "Live" : here.status === "connecting" ? "Connecting…" : "Offline, reconnecting…"}
            />
          )}
          {id === current && here?.status === "offline" && <span className="mr-1 text-xs text-red-600">reconnecting…</span>}
          <button
            type="button"
            title="Close this tab"
            onClick={() => close(id)}
            className={cn("mr-1 rounded p-0.5 hover:bg-muted", id === current ? "opacity-60" : "opacity-0 group-hover:opacity-60")}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      <div ref={addRef} className="relative mb-1 ml-1">
        <button
          type="button"
          title="Open another board in a tab"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setAdding((a) => (a ? null : { x: r.left, y: r.bottom + 2 }));
          }}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          data-testid="board-tabs-add"
        >
          <Plus className="size-4" />
        </button>
      </div>
      {adding && (
        <div
          className="fixed z-50 max-h-80 w-64 overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-lg"
          style={{ top: adding.y, left: adding.x }}
          // outside the + wrapper, so a click in here mustn't count as one outside
          onPointerDown={(e) => e.stopPropagation()}
        >
          {boards === null && <div className="px-2 py-1.5 text-muted-foreground">Loading…</div>}
          {boards && !others.length && <div className="px-2 py-1.5 text-muted-foreground">Every board is open.</div>}
          {others.map((b) => (
            <button
              key={b.id}
              type="button"
              className="block w-full truncate rounded px-2 py-1.5 text-left hover:bg-muted"
              onClick={() => {
                setAdding(null);
                router.push(`/boards/${b.id}`);
              }}
            >
              {b.title}
            </button>
          ))}
        </div>
      )}
    </nav>
  );
}
