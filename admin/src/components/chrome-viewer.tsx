"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Globe, MonitorPlay, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BASE_PATH } from "@/lib/config";

const POLL_MS = 2000;

type Instance = {
  userDataDir: string;
  label: string;
  agentBrowser: boolean;
};
type Page = { id: string; url: string; title: string };

/**
 * Live view of what a headless Chrome instance is currently looking at. Attaches
 * to the instance's DevTools endpoint (server-side) and streams JPEG snapshots.
 */
export function ChromeViewer() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [dir, setDir] = useState<string | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [url, setUrl] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Keep the list of instances fresh (and auto-select the first viewable one).
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/chrome`, {
          cache: "no-store",
        });
        const json = await res.json();
        if (!active) return;
        const list: Instance[] = json.instances ?? [];
        setInstances(list);
        setDir((cur) =>
          cur && list.some((i) => i.userDataDir === cur)
            ? cur
            : (list.find((i) => i.agentBrowser) ?? list[0])?.userDataDir ?? null,
        );
      } catch {
        /* transient */
      }
    };
    void load();
    const id = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  // When the instance changes, load its pages and pick the current one.
  useEffect(() => {
    if (!dir) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPages([]);
      setUrl(null);
      return;
    }
    let active = true;
    (async () => {
      try {
        const res = await fetch(
          `${BASE_PATH}/api/chrome/pages?dir=${encodeURIComponent(dir)}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!active) return;
        const list: Page[] = json.pages ?? [];
        setPages(list);
        setUrl(
          (cur) =>
            (cur && list.some((p) => p.url === cur) && cur) ||
            list.find((p) => !/^(chrome|about|devtools):/.test(p.url))?.url ||
            list[0]?.url ||
            null,
        );
        if (list.length === 0) setError("no open pages in this instance");
      } catch {
        /* transient */
      }
    })();
    return () => {
      active = false;
    };
  }, [dir]);

  // Self-paced snapshot loop: request the next frame only after the current one
  // finishes loading, so slow (Playwright-backed) captures never pile up.
  const shoot = useCallback(() => {
    if (!dir || paused) return;
    const params = new URLSearchParams({ dir });
    if (url) params.set("url", url);
    params.set("t", String(performance.now()));
    setSrc(`${BASE_PATH}/api/chrome/screenshot?${params}`);
  }, [dir, url, paused]);

  useEffect(() => {
    clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (dir && !paused) shoot();
    return () => clearTimeout(timer.current);
  }, [dir, url, paused, shoot]);

  const scheduleNext = useCallback(() => {
    clearTimeout(timer.current);
    if (paused) return;
    timer.current = setTimeout(shoot, POLL_MS);
  }, [paused, shoot]);

  const current = pages.find((p) => p.url === url);
  const viewable = dir && pages.length > 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {instances.length > 1 && (
          <Select value={dir ?? undefined} onValueChange={(v) => setDir(v)}>
            <SelectTrigger size="sm" className="max-w-[16rem]">
              <SelectValue placeholder="Instance" />
            </SelectTrigger>
            <SelectContent>
              {instances.map((i) => (
                <SelectItem key={i.userDataDir} value={i.userDataDir}>
                  {i.label}
                  {i.agentBrowser ? " · agent" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {pages.length > 1 && (
          <Select value={url ?? undefined} onValueChange={(v) => setUrl(v)}>
            <SelectTrigger size="sm" className="max-w-[22rem]">
              <SelectValue placeholder="Tab" />
            </SelectTrigger>
            <SelectContent>
              {pages.map((p) => (
                <SelectItem key={p.id} value={p.url}>
                  {p.title || p.url}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Button
          size="sm"
          variant={paused ? "default" : "outline"}
          onClick={() => setPaused((v) => !v)}
        >
          {paused ? <MonitorPlay /> : <RefreshCw />}
          {paused ? "Resume" : "Live"}
        </Button>

        <span className="ml-auto min-w-0 max-w-full truncate text-xs text-muted-foreground">
          {current ? (
            <span className="inline-flex items-center gap-1.5">
              <Globe className="size-3.5 shrink-0" />
              <span className="truncate">{current.title || current.url}</span>
            </span>
          ) : instances.length === 0 ? (
            "no Chrome instances running"
          ) : (
            "select an instance"
          )}
        </span>
      </div>

      <div className="relative aspect-[16/9] w-full overflow-hidden rounded-md border bg-zinc-950">
        {src && viewable ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={dir + (url ?? "")}
            src={src}
            alt={current ? `Live view of ${current.title || current.url}` : "Live view"}
            className="h-full w-full object-contain"
            onLoad={() => {
              setError(null);
              scheduleNext();
            }}
            onError={() => {
              setError("could not capture (instance busy or closed)");
              scheduleNext();
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {instances.length === 0
              ? "No Chrome instances to view."
              : viewable
                ? "Loading…"
                : error ?? "Nothing to display."}
          </div>
        )}
        {current && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/50 px-2 py-1 font-mono text-[11px] text-zinc-200">
            {current.url}
          </div>
        )}
      </div>

      {error && viewable && (
        <p className="text-xs text-amber-600 dark:text-amber-500">{error}</p>
      )}
      <p className="text-xs text-muted-foreground">
        A read-only snapshot streamed from the instance&rsquo;s DevTools endpoint
        (~every {POLL_MS / 1000}s). Attaching to view never disturbs the browser.
      </p>
    </div>
  );
}
