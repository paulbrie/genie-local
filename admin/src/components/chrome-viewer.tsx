"use client";

import { useEffect, useRef, useState } from "react";
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
  owner: string | null;
  notViewable: string | null;
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
        // Keep the chosen one while it lives; else the first that can be viewed.
        setDir((cur) =>
          cur && list.some((i) => i.userDataDir === cur)
            ? cur
            : (list.find((i) => !i.notViewable) ?? list[0])?.userDataDir ??
              null,
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

  const inst = instances.find((i) => i.userDataDir === dir) ?? null;
  const blocked = inst?.notViewable ?? null;

  // When the instance changes, load its pages and pick the current one.
  useEffect(() => {
    if (!dir || blocked) {
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
  }, [dir, blocked]);

  // Self-paced snapshot loop: the next frame is asked for only after the
  // current one arrived, so slow (Playwright-backed) captures never pile up.
  // Frames are fetched (not an <img src>) so a refusal shows its message: on
  // 404 (gone) or 409 (no DevTools port) the loop stops; a failed capture
  // (502) is retried, while the instance is still in the list.
  const viewable = !!dir && !blocked && pages.length > 0;
  useEffect(() => {
    if (!dir || !viewable || paused) return;
    let alive = true;
    const shoot = async () => {
      const params = new URLSearchParams({ dir });
      if (url) params.set("url", url);
      let again = true;
      try {
        const res = await fetch(`${BASE_PATH}/api/chrome/screenshot?${params}`, {
          cache: "no-store",
        });
        if (!alive) return;
        if (res.ok) {
          const next = URL.createObjectURL(await res.blob());
          if (!alive) return URL.revokeObjectURL(next);
          setSrc((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return next;
          });
          setError(null);
        } else {
          const json = await res.json().catch(() => ({}));
          setError(json.error ?? `HTTP ${res.status}`);
          if (res.status === 404 || res.status === 409) again = false;
        }
      } catch {
        if (alive) setError("could not reach the server");
      }
      if (alive && again) timer.current = setTimeout(shoot, POLL_MS);
    };
    void shoot();
    return () => {
      alive = false;
      clearTimeout(timer.current);
    };
  }, [dir, url, viewable, paused]);

  // A new instance or tab starts with an empty view (no stale frame).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSrc((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setError(null);
  }, [dir, url]);

  const current = pages.find((p) => p.url === url);

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
                  {i.owner ? `${i.owner} · ` : ""}
                  {i.label}
                  {i.agentBrowser ? " · agent" : ""}
                  {i.notViewable ? " · can't view" : ""}
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
          ) : blocked && inst ? (
            `${inst.owner ? `${inst.owner} · ` : ""}${inst.label}: can't view`
          ) : (
            "select an instance"
          )}
        </span>
      </div>

      <div className="relative aspect-[16/9] w-full overflow-hidden rounded-md border bg-zinc-950">
        {src && viewable ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={current ? `Live view of ${current.title || current.url}` : "Live view"}
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-sm text-muted-foreground">
            {instances.length === 0 ? (
              "No Chrome instances to view."
            ) : blocked ? (
              <>
                <span className="font-medium text-zinc-200">
                  {inst?.owner ? `${inst.owner}'s browser` : "This instance"} can&rsquo;t be shown
                </span>
                <span>{blocked}.</span>
                <span className="text-xs">
                  Launch it with <code>--remote-debugging-port=0</code> (or a fixed port) to view it here.
                </span>
              </>
            ) : viewable ? (
              error ?? "Loading…"
            ) : (
              error ?? "Nothing to display."
            )}
          </div>
        )}
        {current && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/50 px-2 py-1 font-mono text-[11px] text-zinc-200">
            {current.url}
          </div>
        )}
      </div>

      {error && viewable && src && (
        <p className="text-xs text-amber-600 dark:text-amber-500">{error}</p>
      )}
      <p className="text-xs text-muted-foreground">
        A read-only snapshot streamed from the instance&rsquo;s DevTools endpoint
        (~every {POLL_MS / 1000}s). Attaching to view never disturbs the browser.
      </p>
    </div>
  );
}
