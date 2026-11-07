"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Download,
  Globe,
  ListTree,
  Monitor,
  Pencil,
  Plus,
  RotateCw,
  Unplug,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { BASE_PATH } from "@/lib/config";
import { cn } from "@/lib/utils";
import { DesktopControl } from "@/components/browsers/desktop-control";
import type { DesktopState } from "@/lib/browsers/db";

// Spiridus Desktop's builds (admin/desktop, .github/workflows/desktop.yml): the latest, unsigned
const DESKTOP_RELEASE = "https://github.com/paulbrie/genie-local/releases/download/desktop-latest";
const DESKTOP_DOWNLOADS = [
  { label: "macOS (Apple Silicon)", file: "Spiridus-Desktop-macos-arm64.dmg" },
  { label: "macOS (Intel)", file: "Spiridus-Desktop-macos-x64.dmg" },
  { label: "Windows", file: "Spiridus-Desktop-windows-x64-setup.exe" },
];

type Tab = { id: number; windowId: number; url: string; title: string; active: boolean; opened?: boolean; attached?: boolean };
type Browser = {
  id: number;
  name: string;
  kind: "chrome" | "desktop";
  state: DesktopState;
  createdBy: string | null;
  lastSeenAt: string | null;
  info: { userAgent?: string; platform?: string; version?: string; os?: string; hostname?: string };
  online: boolean;
  tabs: Tab[];
  unsharedTabs: number;
};
type Shot = { dataUrl: string; viewport: { width: number; height: number } };
type Ev = { seq: number; at: number; kind: string; tabId?: number; data?: Record<string, unknown> };

const API = `${BASE_PATH}/api/browsers`;
const LIST_MS = 3000;
const LIVE_MS = 700;

async function command<T = unknown>(browserId: number, type: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${API}/${browserId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, args }),
  });
  const r = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!r.ok) throw new Error(r.error ?? `HTTP ${res.status}`);
  return r.data as T;
}

const browserLabel = (ua?: string) => {
  if (!ua) return "";
  const m = ua.match(/(Edg|OPR|Chrome)\/(\d+)/);
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  const name = m ? ({ Edg: "Edge", OPR: "Opera", Chrome: "Chrome" } as Record<string, string>)[m[1]] + " " + m[2] : "";
  return [name, os].filter(Boolean).join(" · ");
};

/** Pair browsers with the Spiridus Bridge extension, and drive the tabs they share. */
export function BrowsersPanel() {
  const [browsers, setBrowsers] = useState<Browser[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [pickedTab, setTabId] = useState<number | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await fetch(API, { cache: "no-store" });
      const json = await res.json();
      const list: Browser[] = json.browsers ?? [];
      setBrowsers(list);
      setSelected((cur) => (cur && list.some((b) => b.id === cur) ? cur : (list.find((b) => b.online)?.id ?? null)));
    } catch {
      /* next poll */
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, LIST_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  // A pairing code counts down; the browser it paired shows up in the list.
  useEffect(() => {
    if (!pairing) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pairing]);
  // The browsers there were when the code was made: one that isn't among them is the one it paired.
  const before = useRef<Set<number> | null>(null);
  useEffect(() => {
    const fresh = before.current && browsers?.find((b) => !before.current!.has(b.id));
    if (!fresh) return;
    before.current = null;
    toast.success(`Paired with ${fresh.name}`);
    setPairing(null);
    setSelected(fresh.id);
  }, [browsers]);

  const browser = browsers?.find((b) => b.id === selected) ?? null;
  // The tab picked while it's still shared, else the browser's active one, else the first.
  const tabs = browser?.tabs ?? [];
  const tabId = tabs.some((t) => t.id === pickedTab) ? pickedTab : (tabs.find((t) => t.active)?.id ?? tabs[0]?.id ?? null);

  const newCode = async () => {
    const res = await fetch(`${API}/pair-code`, { method: "POST" });
    const json = await res.json();
    if (!res.ok) return toast.error(json.error ?? "Couldn't make a code");
    before.current = new Set((browsers ?? []).map((b) => b.id));
    setNow(Date.now());
    setPairing(json);
  };

  const rename = async (b: Browser) => {
    const name = prompt("Name this browser", b.name)?.trim();
    if (!name || name === b.name) return;
    await fetch(`${API}/${b.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    load();
  };
  const unpair = async (b: Browser) => {
    if (!confirm(`Unpair ${b.name}? Its extension will need a new code to connect again.`)) return;
    await fetch(`${API}/${b.id}`, { method: "DELETE" });
    load();
  };

  const left = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0;

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-wrap items-start gap-3">
        <Button onClick={newCode}>
          <Plus /> Pair a browser or computer
        </Button>
        <a href={`${API}/extension`} download className={buttonVariants({ variant: "outline" })}>
          <Download /> Chrome extension
        </a>
        <details className="relative">
          <summary className={cn(buttonVariants({ variant: "outline" }), "cursor-pointer list-none")}>
            <Monitor /> Spiridus Desktop
          </summary>
          <div className="absolute z-10 mt-1 flex w-72 flex-col gap-1 rounded-lg border bg-background p-2 text-sm shadow-lg">
            {DESKTOP_DOWNLOADS.map((d) => (
              <a key={d.file} href={`${DESKTOP_RELEASE}/${d.file}`} className="rounded px-2 py-1 hover:bg-muted">
                <Download className="mr-1.5 inline size-3.5" />
                {d.label}
              </a>
            ))}
            <p className="px-2 pt-1 text-xs text-muted-foreground">
              Unsigned test builds. macOS: right-click the app → Open the first time, then allow Screen Recording and
              Accessibility. Windows: More info → Run anyway.
            </p>
          </div>
        </details>
        {pairing && left > 0 && (
          <div className="flex-1 rounded-lg border p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                Code: <span className="font-mono text-lg font-semibold tracking-widest">{pairing.code}</span>{" "}
                <span className="text-muted-foreground">
                  ({Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} left, works once)
                </span>
              </div>
              <Button size="icon" variant="ghost" onClick={() => setPairing(null)} aria-label="Close">
                <X />
              </Button>
            </div>
            <p className="mt-2 text-muted-foreground">
              <b>A computer</b>: open Spiridus Desktop, type this address and code:{" "}
              <span className="font-mono">{typeof window !== "undefined" ? `${location.origin}${BASE_PATH}` : ""}</span>
            </p>
            <p className="mt-1 text-muted-foreground"><b>Chrome</b>:</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-muted-foreground">
              <li>Download the extension and unzip it.</li>
              <li>
                In Chrome open <span className="font-mono">chrome://extensions</span>, switch on Developer mode, click{" "}
                <b>Load unpacked</b> and pick the <span className="font-mono">spiridus-bridge</span> folder.
              </li>
              <li>Click the extension&apos;s icon, type this code and a name for the browser, then Pair.</li>
              <li>Share a tab from the same popup (or every tab); Spiridus can then see and drive it.</li>
            </ol>
          </div>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Browsers and computers</h2>
          {browsers === null && <p className="text-sm text-muted-foreground">Loading…</p>}
          {browsers?.length === 0 && <p className="text-sm text-muted-foreground">None paired yet.</p>}
          {browsers?.map((b) => (
            <div
              key={b.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelected(b.id)}
              onKeyDown={(e) => e.key === "Enter" && setSelected(b.id)}
              className={cn(
                "group cursor-pointer rounded-lg border p-2.5 text-sm transition-colors hover:bg-muted/50",
                selected === b.id && "border-primary bg-muted/50",
              )}
            >
              <div className="flex items-center gap-2">
                <StatusDot color={b.online ? "bg-emerald-500" : "bg-zinc-400"} pulse={b.online} label={b.online ? "connected" : "offline"} />
                {b.kind === "desktop" ? <Monitor className="size-3.5 text-muted-foreground" /> : <Globe className="size-3.5 text-muted-foreground" />}
                <span className="flex-1 truncate font-medium">{b.name}</span>
                <button className="opacity-0 group-hover:opacity-100" onClick={(e) => (e.stopPropagation(), rename(b))} aria-label="Rename">
                  <Pencil className="size-3.5" />
                </button>
                <button className="opacity-0 group-hover:opacity-100" onClick={(e) => (e.stopPropagation(), unpair(b))} aria-label="Unpair">
                  <Unplug className="size-3.5" />
                </button>
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {b.kind === "desktop" ? [b.info.os, b.info.hostname].filter(Boolean).join(" · ") : browserLabel(b.info.userAgent)}
                {b.online
                  ? b.kind === "desktop"
                    ? b.state.paused
                      ? " · paused"
                      : ` · ${b.state.displays?.length ?? 0} display${b.state.displays?.length === 1 ? "" : "s"}`
                    : ` · ${b.tabs.length} shared tab${b.tabs.length === 1 ? "" : "s"}`
                  : b.lastSeenAt
                    ? ` · seen ${new Date(b.lastSeenAt).toLocaleString()}`
                    : ""}
              </div>
            </div>
          ))}
        </div>

        <div className="min-w-0">
          {!browser ? (
            <p className="text-sm text-muted-foreground">Pick a browser or a computer.</p>
          ) : !browser.online ? (
            <p className="text-sm text-muted-foreground">
              {browser.kind === "desktop"
                ? `${browser.name} isn't connected: it's off or asleep, nobody is logged in, or Spiridus Desktop was quit or unpaired.`
                : `${browser.name} isn't connected: Chrome is closed, or its extension was removed or unpaired.`}
            </p>
          ) : browser.kind === "desktop" ? (
            <DesktopControl id={browser.id} name={browser.name} state={browser.state} />
          ) : (
            <BrowserControl browser={browser} tabId={tabId} setTabId={setTabId} />
          )}
        </div>
      </section>
    </div>
  );
}

function BrowserControl({ browser, tabId, setTabId }: { browser: Browser; tabId: number | null; setTabId: (id: number) => void }) {
  const [openUrl, setOpenUrl] = useState("");
  const tab = browser.tabs.find((t) => t.id === tabId) ?? null;

  const open = async () => {
    let url = openUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
      const t = await command<Tab>(browser.id, "open", { url });
      setTabId(t.id);
      setOpenUrl("");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {browser.tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTabId(t.id)}
            title={t.url}
            className={cn(
              "flex max-w-56 items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-muted/50",
              t.id === tabId && "border-primary bg-muted/50",
            )}
          >
            <span className="truncate">{t.title || t.url}</span>
            {t.opened && <Badge variant="secondary" className="px-1 py-0 text-[10px]">opened</Badge>}
          </button>
        ))}
        {browser.tabs.length === 0 && (
          <span className="text-sm text-muted-foreground">
            No tab shared yet: share one from the extension&apos;s popup, or open one here.
          </span>
        )}
        <form className="ml-auto flex gap-1.5" onSubmit={(e) => (e.preventDefault(), open())}>
          <Input value={openUrl} onChange={(e) => setOpenUrl(e.target.value)} placeholder="Open a tab at…" className="h-8 w-56" />
          <Button size="sm" type="submit" variant="outline">
            Open
          </Button>
        </form>
      </div>
      {browser.unsharedTabs > 0 && (
        <p className="-mt-1 text-xs text-muted-foreground">
          {browser.unsharedTabs} other tab{browser.unsharedTabs === 1 ? " isn't" : "s aren't"} shared.
        </p>
      )}
      {tab && <TabControl key={`${browser.id}:${tab.id}`} browserId={browser.id} tab={tab} />}
      <EventLog browserId={browser.id} />
    </div>
  );
}

function TabControl({ browserId, tab }: { browserId: number; tab: Tab }) {
  const [url, setUrl] = useState(tab.url);
  const [shot, setShot] = useState<Shot | null>(null);
  const [live, setLive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [js, setJs] = useState("");
  const [out, setOut] = useState<{ q: string; a: string; bad?: boolean }[]>([]);
  const img = useRef<HTMLImageElement>(null);
  const busy = useRef(false);

  useEffect(() => setUrl(tab.url), [tab.url]);

  const run = useCallback(
    async <T,>(type: string, args: Record<string, unknown> = {}) => command<T>(browserId, type, { tabId: tab.id, ...args }),
    [browserId, tab.id],
  );
  const act = async (type: string, args: Record<string, unknown> = {}) => {
    try {
      await run(type, args);
      setError(null);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      setShot(await run<Shot>("screenshot", { quality: 60 }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [run]);

  useEffect(() => {
    refresh();
    if (!live) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const loop = async () => {
      if (stop) return;
      if (document.visibilityState === "visible") await refresh();
      t = setTimeout(loop, LIVE_MS);
    };
    t = setTimeout(loop, LIVE_MS);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [live, refresh]);

  /** Screenshot pixels → the page's CSS px. */
  const toPage = (e: React.MouseEvent) => {
    const el = img.current;
    if (!el || !shot) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * shot.viewport.width),
      y: Math.round(((e.clientY - r.top) / r.height) * shot.viewport.height),
    };
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
    e.preventDefault();
    const mods = [e.ctrlKey && "Control", e.altKey && "Alt", e.metaKey && "Meta", e.shiftKey && e.key.length > 1 && "Shift"].filter(Boolean);
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) act("type", { text: e.key });
    else act("key", { key: [...mods, e.key === " " ? "Space" : e.key].join("+") });
  };

  const evaluate = async () => {
    const q = js.trim();
    if (!q) return;
    try {
      const a = await run("eval", { expression: q });
      setOut((o) => [...o.slice(-30), { q, a: typeof a === "string" ? a : JSON.stringify(a, null, 2) }]);
    } catch (e) {
      setOut((o) => [...o.slice(-30), { q, a: (e as Error).message, bad: true }]);
    }
    setJs("");
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Button size="icon" variant="ghost" onClick={() => act("back")} aria-label="Back">
          <ArrowLeft />
        </Button>
        <Button size="icon" variant="ghost" onClick={() => act("forward")} aria-label="Forward">
          <ArrowRight />
        </Button>
        <Button size="icon" variant="ghost" onClick={() => act("reload")} aria-label="Reload">
          <RotateCw />
        </Button>
        <form className="flex-1" onSubmit={(e) => (e.preventDefault(), act("navigate", { url: /^https?:\/\//i.test(url) ? url : `https://${url}` }))}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} className="h-8 font-mono text-xs" />
        </form>
        <Button size="sm" variant="outline" onClick={() => act("activate")}>
          Bring to front
        </Button>
        <Button size="sm" variant={live ? "secondary" : "outline"} onClick={() => setLive((v) => !v)}>
          <Camera /> {live ? "Live" : "Paused"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            try {
              const s = await run<{ elements: string }>("snapshot");
              setSnapshot(s.elements);
            } catch (e) {
              toast.error((e as Error).message);
            }
          }}
        >
          <ListTree /> Elements
        </Button>
        <Button size="sm" variant="ghost" onClick={() => confirm("Close this tab in the browser?") && act("close")}>
          <X /> Close
        </Button>
      </div>

      <div
        tabIndex={0}
        onKeyDown={onKey}
        className="relative overflow-hidden rounded-lg border bg-muted/30 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title="Click to click in the page; with this focused, typing types into it; the wheel scrolls it"
      >
        {shot ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={img}
            src={shot.dataUrl}
            alt={tab.title}
            draggable={false}
            className="block w-full cursor-crosshair select-none"
            onClick={(e) => {
              const p = toPage(e);
              (e.currentTarget.parentElement as HTMLElement).focus();
              if (p) act("click", p);
            }}
            onDoubleClick={(e) => {
              const p = toPage(e);
              if (p) act("click", { ...p, clickCount: 2 });
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              const p = toPage(e);
              if (p) act("click", { ...p, button: "right" });
            }}
            onWheel={(e) => {
              const p = toPage(e);
              if (p) act("scroll", { ...p, dx: e.deltaX, dy: e.deltaY });
            }}
          />
        ) : (
          <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">{error ?? "Loading…"}</div>
        )}
        {shot && error && <div className="absolute inset-x-0 bottom-0 bg-background/90 p-2 text-xs text-destructive">{error}</div>}
      </div>

      {snapshot !== null && (
        <div className="rounded-lg border">
          <div className="flex items-center justify-between border-b px-2 py-1 text-xs text-muted-foreground">
            Interactive elements (refs for agents: click / type with <span className="font-mono">ref</span>)
            <Button size="icon" variant="ghost" className="size-6" onClick={() => setSnapshot(null)} aria-label="Close">
              <X />
            </Button>
          </div>
          <pre className="max-h-72 overflow-auto p-2 text-xs">{snapshot || "(nothing interactive visible)"}</pre>
        </div>
      )}

      <div className="rounded-lg border">
        <div className="max-h-60 overflow-auto p-2 font-mono text-xs">
          {out.length === 0 && <div className="text-muted-foreground">Run JavaScript in the page (awaited; top-level await works).</div>}
          {out.map((o, i) => (
            <div key={i} className="border-b py-1 last:border-0">
              <div className="text-muted-foreground">&gt; {o.q}</div>
              <pre className={cn("whitespace-pre-wrap", o.bad && "text-destructive")}>{o.a}</pre>
            </div>
          ))}
        </div>
        <form className="border-t" onSubmit={(e) => (e.preventDefault(), evaluate())}>
          <Input
            value={js}
            onChange={(e) => setJs(e.target.value)}
            placeholder="document.title"
            className="h-8 rounded-none border-0 font-mono text-xs shadow-none focus-visible:ring-0"
          />
        </form>
      </div>
    </div>
  );
}

function EventLog({ browserId }: { browserId: number }) {
  const [events, setEvents] = useState<Ev[]>([]);

  useEffect(() => {
    let stop = false;
    let after = 0;
    const ctl = new AbortController();
    (async () => {
      // Start from now: the events from before this was opened are history.
      try {
        const first = await (await fetch(`${API}/${browserId}/events?after=${Number.MAX_SAFE_INTEGER}`, { signal: ctl.signal })).json();
        after = first.seq ?? 0;
      } catch {
        /* below */
      }
      while (!stop) {
        try {
          const r = await (await fetch(`${API}/${browserId}/events?after=${after}&wait=25`, { cache: "no-store", signal: ctl.signal })).json();
          if (Array.isArray(r.events) && r.events.length) setEvents((e) => [...e, ...r.events].slice(-200));
          after = r.seq ?? after;
        } catch {
          if (stop) return;
          await new Promise((res) => setTimeout(res, 3000));
        }
      }
    })();
    return () => {
      stop = true;
      ctl.abort();
    };
  }, [browserId]);

  return (
    <details className="rounded-lg border text-xs" open>
      <summary className="cursor-pointer px-2 py-1 text-muted-foreground">Events ({events.length})</summary>
      <div className="max-h-48 overflow-auto px-2 pb-2 font-mono">
        {events.length === 0 && <div className="text-muted-foreground">Console output, page errors, navigations and dialogs show up here.</div>}
        {[...events].reverse().map((e) => (
          <div key={e.seq} className={cn("truncate", e.kind === "error" && "text-destructive")}>
            <span className="text-muted-foreground">{new Date(e.at).toLocaleTimeString()}</span> {e.kind}
            {e.tabId ? ` [${e.tabId}]` : ""}{" "}
            {String(e.data?.text ?? e.data?.url ?? e.data?.message ?? e.data?.reason ?? "")}
          </div>
        ))}
      </div>
    </details>
  );
}
