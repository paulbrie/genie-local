"use client";

import { ChevronDown, ChevronUp, type LucideIcon, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useSubject } from "subjecto/react";

import { AppIcon } from "@/components/desktop/app-icon";
import { NAV_FLAT } from "@/components/nav-items";
import { BASE_PATH } from "@/lib/config";
import { WIDGET_APP, type WidgetId } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { desk, raiseApp, raisePath, setWidgetMode, setWidgetView } from "@/store/desktop";

// What the desktop's widgets are made of (status-widget.tsx, more-widgets.tsx): a header that's the grip their frame
// (desktop.tsx's WidgetFrame) is dragged by and, folded, all of the widget; the list under it; its rows; a meter.

/**
 * A widget's header, the grip its frame is dragged by: its icon and name, what matters now, its count, then fold and
 * hide (those two only while the pointer is over the widget, or a key's focus is on them: they keep their room, so
 * nothing moves when they show). Folded, the widget is one row of the grid tall and this is all of it, as a glance: the
 * icon on a tile, the name over what matters, the count larger; a double-click unfolds it. The app it's a glance at,
 * when there's one, is its own icon, always there.
 */
export function WidgetHeader({
  id,
  icon: Icon,
  title,
  count,
  note,
  folded,
}: {
  id: WidgetId;
  icon: LucideIcon;
  title: string;
  count: number | string | null;
  note: string;
  folded: boolean;
}) {
  const btn = "rounded-md p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground";
  const openApp = useOpenApp();
  // (the app it's a glance at, by its own icon)
  const app = WIDGET_APP[id] ? NAV_FLAT.find((n) => n.href === WIDGET_APP[id]) : undefined;
  const appButton = app && (
    <button
      type="button"
      onClick={() => openApp(app.href)}
      aria-label={`Open ${app.label}`}
      title={`Open ${app.label}`}
      className="shrink-0 rounded-md p-px opacity-80 transition hover:scale-110 hover:opacity-100"
    >
      <AppIcon item={app} size={16} />
    </button>
  );
  // (on a device that can't hover, a tablet's touch, they're always there)
  const onHover = "opacity-0 transition-opacity group-hover/widget:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100";
  const controls = (
    <>
      <button
        type="button"
        onClick={() => setWidgetMode(id, folded ? "open" : "collapsed")}
        aria-label={folded ? "Unfold" : "Fold"}
        title={folded ? "Unfold" : "Fold"}
        className={btn}
      >
        {folded ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
      </button>
      <button
        type="button"
        onClick={() => setWidgetMode(id, "hidden")}
        aria-label="Hide (right-click the desktop to bring it back)"
        title="Hide (right-click the desktop to bring it back)"
        className={btn}
      >
        <X className="size-3.5" />
      </button>
    </>
  );
  if (folded)
    return (
      <div
        data-widget-grip
        onDoubleClick={(e) => !(e.target as HTMLElement).closest("button") && setWidgetMode(id, "open")}
        className="flex h-full items-center gap-3 px-3.5 select-none"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.07] ring-1 ring-foreground/5">
          <Icon className="size-5 text-foreground/70" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] leading-5 font-semibold">{title}</span>
          <span className="truncate text-xs text-muted-foreground">{note}</span>
        </div>
        {count !== null && <span className="shrink-0 text-xl leading-none font-semibold tabular-nums">{count}</span>}
        <div className="flex shrink-0 flex-col items-center gap-0.5">
          {appButton}
          <div className={cn("flex flex-col gap-0.5", onHover)}>{controls}</div>
        </div>
      </div>
    );
  return (
    <div data-widget-grip className="flex shrink-0 items-center gap-2 px-3 pt-2.5 pb-2 select-none">
      <Icon className="size-[15px] shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-[13px] font-semibold">{title}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{note}</span>
      {count !== null && <span className="text-xs text-muted-foreground tabular-nums opacity-80">{count}</span>}
      {appButton}
      <span className={cn("flex shrink-0 items-center gap-0.5", onHover)}>{controls}</span>
    </div>
  );
}

/**
 * A widget's list, scrolling when it holds more than the widget's room. Its rows never shrink to fit (a row clipping
 * its own bar, overflow-hidden, otherwise would, to nothing, and the rows would pile on each other).
 */
export function WidgetList({ children }: { children: React.ReactNode }) {
  return <div className="scrollbar-clear @container flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-2 [&>*]:shrink-0">{children}</div>;
}

/** The sidebar's sub-item row (app-sidebar.tsx): its size, padding and indent under the heading's label. */
export const ROW =
  "flex w-full min-w-0 items-center gap-2 rounded-md py-0.5 pr-2 pl-7 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground";

/** A bar for a share (0..1): amber past 80%, red past 90% (a disk filling up). */
export function Meter({ value, thin }: { value: number; thin?: boolean }) {
  const v = Math.min(Math.max(value, 0), 1);
  return (
    <div className={cn("w-full overflow-hidden rounded-full bg-foreground/10", thin ? "h-1" : "h-1.5")}>
      <div
        className={cn("h-full rounded-full", v > 0.9 ? "bg-red-500" : v > 0.8 ? "bg-amber-500" : "bg-sky-500")}
        style={{ width: `${Math.max(v * 100, v > 0 ? 1 : 0)}%` }}
      />
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-0.5 pr-2 pl-7 text-xs text-muted-foreground">{children}</p>;
}

/**
 * A widget's data from `path` (under the basePath), again every `everyMs` while it's on the desktop (an error keeps the
 * last data and says so); `reload` asks again now. The answer can ask to be asked sooner (`soon`: e.g. while measuring).
 */
export function usePolled<T>(path: string | null, everyMs: number, soon?: (data: T) => number | null) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    // (no path: nothing to ask for now)
    if (!path) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      let next = everyMs;
      try {
        const r = await fetch(`${BASE_PATH}${path}`, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const json = (await r.json()) as T;
        if (!live) return;
        setData(json);
        setFailed(false);
        next = soon?.(json) ?? everyMs;
      } catch {
        if (live) setFailed(true);
      }
      if (live) timer = setTimeout(load, next);
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // (soon is read once per answer; a new function each render mustn't restart the polling)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, everyMs, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, failed, reload };
}

/** A page (a project's tab, Services…) from a widget: inline, or its window to the front if it's popped out. */
export function useOpenPath() {
  const router = useRouter();
  return (path: string) => {
    if (!raisePath(path)) router.push(path);
  };
}

/** One of a widget's choices of how to show, by `key` (one of `views`; `fallback` until one's picked), remembered with the desktop. */
export function useWidgetView<T extends string>(id: WidgetId, key: string, views: readonly T[], fallback: T): [T, (v: T) => void] {
  const [{ widgets }] = useSubject(desk);
  const saved = widgets?.[id]?.views?.[key];
  const view = saved && (views as readonly string[]).includes(saved) ? (saved as T) : fallback;
  return [view, (v: T) => setWidgetView(id, key, v)];
}

/** A widget's small switch between ways of showing: words, or icons (their name the tooltip). */
export function ViewSwitch<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string; icon?: LucideIcon }[];
}) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 rounded-md bg-foreground/[0.06] p-0.5 text-[10px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          aria-label={o.icon ? o.label : undefined}
          title={o.icon ? o.label : undefined}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex items-center rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-foreground",
            value === o.value && "bg-background text-foreground shadow-sm",
          )}
        >
          {o.icon ? <o.icon className="size-3" /> : o.label}
        </button>
      ))}
    </div>
  );
}

/** An app (an href of NAV) from a widget: inline, or its window to the front if it's popped out. */
export function useOpenApp() {
  const router = useRouter();
  return (href: string) => {
    if (!raiseApp(href)) router.push(href);
  };
}

/** A small heading inside a widget's list ("Connected", "Failed today"). */
export function Subhead({ children }: { children: React.ReactNode }) {
  return <p className="pt-1.5 pr-2 pb-0.5 pl-7 text-[10px] font-medium tracking-wider text-muted-foreground/70 uppercase">{children}</p>;
}

/** "3 min ago", from a time in ms or an ISO string (short: a widget's line is narrow). */
export function ago(at: number | string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** The widgets' ids, re-exported for the registry's maps. */
export type { WidgetId };
