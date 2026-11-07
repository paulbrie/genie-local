"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ClipboardCopy, File, Folder, ListTree, Monitor, Play, Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BASE_PATH } from "@/lib/config";
import { cn } from "@/lib/utils";

const API = `${BASE_PATH}/api/browsers`;
const LIVE_MS = 800;

type Display = { id: number; name: string; width: number; height: number; scale: number; primary: boolean };
type DesktopState = {
  displays?: Display[];
  os?: string;
  hostname?: string;
  user?: string;
  paused?: boolean;
  allow?: { input?: boolean; shell?: boolean; files?: boolean };
};
type Shot = { dataUrl: string; display: number; width: number; height: number };

async function command<T = unknown>(id: number, type: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
  const res = await fetch(`${API}/${id}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, args, ...(timeoutMs ? { timeoutMs } : {}) }),
  });
  const r = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!r.ok) throw new Error(r.error ?? `HTTP ${res.status}`);
  return r.data as T;
}

/** A browser key event → Spiridus Desktop's key names ("ctrl+shift+tab", "enter", "f5"). */
function keyName(e: React.KeyboardEvent): string | null {
  const named: Record<string, string> = {
    Enter: "enter", Tab: "tab", Escape: "esc", Backspace: "backspace", Delete: "delete", ArrowUp: "up", ArrowDown: "down",
    ArrowLeft: "left", ArrowRight: "right", Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown", " ": "space",
  };
  const k = named[e.key] ?? (/^F\d{1,2}$/.test(e.key) ? e.key.toLowerCase() : e.key.length === 1 ? e.key.toLowerCase() : null);
  if (!k) return null;
  const mods = [e.ctrlKey && "ctrl", e.altKey && "alt", e.metaKey && "cmd", e.shiftKey && e.key.length > 1 && "shift"].filter(Boolean);
  return [...mods, k].join("+");
}

/** A paired computer (Spiridus Desktop): its screens live, mouse and keyboard, its UI, a shell, files, the clipboard, apps. */
export function DesktopControl({ id, name, state }: { id: number; name: string; state: DesktopState }) {
  const displays = state.displays ?? [];
  const [display, setDisplay] = useState<number | null>(null);
  const shown = displays.find((d) => d.id === display) ?? displays.find((d) => d.primary) ?? displays[0] ?? null;
  const allow = state.allow ?? {};
  const run = useCallback(<T,>(type: string, args: Record<string, unknown> = {}, timeoutMs?: number) => command<T>(id, type, { by: "Spiridus", ...args }, timeoutMs), [id]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Monitor className="size-4 text-muted-foreground" />
        <span className="font-medium">{name}</span>
        <span className="text-muted-foreground">
          {[state.os, state.user && `as ${state.user}`].filter(Boolean).join(" · ")}
        </span>
        {state.paused && <Badge variant="destructive">paused by its owner</Badge>}
        {allow.input === false && <Badge variant="secondary">no mouse/keyboard</Badge>}
        {allow.shell === false && <Badge variant="secondary">no commands</Badge>}
        {allow.files === false && <Badge variant="secondary">no files</Badge>}
        {displays.length > 1 && (
          <div className="ml-auto flex gap-1">
            {displays.map((d) => (
              <Button key={d.id} size="sm" variant={shown?.id === d.id ? "secondary" : "outline"} onClick={() => setDisplay(d.id)}>
                {d.name || `Display ${d.id}`} {d.primary ? "(main)" : ""}
              </Button>
            ))}
          </div>
        )}
      </div>
      {shown && <Screen key={shown.id} display={shown} run={run} />}
      <div className="grid gap-3 lg:grid-cols-2">
        <Shell run={run} />
        <Files run={run} />
        <UiTree run={run} />
        <Extras run={run} />
      </div>
    </div>
  );
}

type Run = <T>(type: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

function Screen({ display, run }: { display: Display; run: Run }) {
  const [shot, setShot] = useState<Shot | null>(null);
  const [live, setLive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      setShot(await run<Shot>("screenshot", { display: display.id, maxWidth: 1600, quality: 60 }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [run, display.id]);

  useEffect(() => {
    const first = setTimeout(refresh, 0);
    if (!live) return () => clearTimeout(first);
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
      clearTimeout(first);
      clearTimeout(t);
    };
  }, [live, refresh]);

  const act = async (type: string, args: Record<string, unknown>) => {
    try {
      await run(type, { display: display.id, ...args });
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  /** the picture's pixels → the display's points */
  const at = (e: React.MouseEvent) => {
    const r = img.current?.getBoundingClientRect();
    if (!r || !shot) return null;
    return { x: Math.round(((e.clientX - r.left) / r.width) * shot.width), y: Math.round(((e.clientY - r.top) / r.height) * shot.height) };
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {display.width}×{display.height} points{display.scale !== 1 ? ` (×${display.scale})` : ""}: click, double-click, right-click, scroll; focus it to type
        </span>
        <Button size="sm" variant={live ? "secondary" : "outline"} className="ml-auto" onClick={() => setLive((v) => !v)}>
          <Camera /> {live ? "Live" : "Paused"}
        </Button>
      </div>
      <div
        tabIndex={0}
        className="relative overflow-hidden rounded-lg border bg-muted/30 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onKeyDown={(e) => {
          if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
          e.preventDefault();
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) act("type", { text: e.key });
          else {
            const k = keyName(e);
            if (k) act("key", { key: k });
          }
        }}
      >
        {shot ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={img}
            src={shot.dataUrl}
            alt="The computer's screen"
            draggable={false}
            className="block w-full cursor-crosshair select-none"
            onClick={(e) => {
              (e.currentTarget.parentElement as HTMLElement).focus();
              const p = at(e);
              if (p) act("click", p);
            }}
            onDoubleClick={(e) => {
              const p = at(e);
              if (p) act("click", { ...p, count: 2 });
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              const p = at(e);
              if (p) act("click", { ...p, button: "right" });
            }}
            onWheel={(e) => {
              const p = at(e);
              const notches = Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 100));
              if (p) act("scroll", { ...p, dy: notches });
            }}
          />
        ) : (
          <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">{error ?? "Loading…"}</div>
        )}
        {shot && error && <div className="absolute inset-x-0 bottom-0 bg-background/90 p-2 text-xs text-destructive">{error}</div>}
      </div>
    </div>
  );
}

function Panel({ title, icon, children, className }: { title: string; icon: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2 rounded-lg border p-2.5", className)}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

function Shell({ run }: { run: Run }) {
  const [cmd, setCmd] = useState("");
  const [out, setOut] = useState<{ q: string; a: string; bad?: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const exec = async () => {
    const q = cmd.trim();
    if (!q) return;
    setBusy(true);
    try {
      const r = await run<{ code: number | null; stdout: string; stderr: string }>("run", { command: q, timeoutMs: 120_000 }, 130_000);
      setOut((o) => [...o.slice(-20), { q, a: `${r.stdout}${r.stderr}`.trimEnd() + (r.code ? `\n(exit ${r.code})` : ""), bad: !!r.code }]);
    } catch (e) {
      setOut((o) => [...o.slice(-20), { q, a: (e as Error).message, bad: true }]);
    } finally {
      setBusy(false);
      setCmd("");
    }
  };
  return (
    <Panel title="Command" icon={<Play className="size-3.5" />}>
      <div className="max-h-56 overflow-auto font-mono text-xs">
        {out.length === 0 && <div className="text-muted-foreground">Runs in a shell on the computer (zsh/sh, PowerShell on Windows).</div>}
        {out.map((o, i) => (
          <div key={i} className="border-b py-1 last:border-0">
            <div className="text-muted-foreground">$ {o.q}</div>
            <pre className={cn("whitespace-pre-wrap", o.bad && "text-destructive")}>{o.a || "(no output)"}</pre>
          </div>
        ))}
      </div>
      <form onSubmit={(e) => (e.preventDefault(), exec())}>
        <Input value={cmd} onChange={(e) => setCmd(e.target.value)} disabled={busy} placeholder={busy ? "Running…" : "ls ~/Desktop"} className="h-8 font-mono text-xs" />
      </form>
    </Panel>
  );
}

type Item = { name: string; dir: boolean; size: number };

function Files({ run }: { run: Run }) {
  const [path, setPath] = useState("~");
  const [items, setItems] = useState<Item[] | null>(null);
  const [preview, setPreview] = useState<{ path: string; text?: string; size: number } | null>(null);
  const join = (a: string, b: string) => (a.endsWith("/") || a.endsWith("\\") ? a + b : `${a}${a.includes("\\") ? "\\" : "/"}${b}`);
  const list = async (p: string) => {
    try {
      const r = await run<{ path: string; items: Item[] }>("ls", { path: p });
      setPath(r.path);
      setItems(r.items);
      setPreview(null);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const open = async (it: Item) => {
    const p = join(path, it.name);
    if (it.dir) return list(p);
    try {
      const r = await run<{ path: string; size: number; text?: string; base64?: string }>("read", { path: p, max: 20_000_000 }, 120_000);
      if (r.text !== undefined && r.size < 200_000) setPreview({ path: r.path, text: r.text, size: r.size });
      else {
        const bytes = r.base64 ? Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)) : new TextEncoder().encode(r.text ?? "");
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([bytes]));
        a.download = it.name;
        a.click();
        URL.revokeObjectURL(a.href);
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const upload = async (f: globalThis.File) => {
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    try {
      await run("write", { path: join(path, f.name), base64: btoa(bin) }, 120_000);
      toast.success(`Uploaded ${f.name}`);
      list(path);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const parent = path.replace(/[\\/][^\\/]+[\\/]?$/, "") || "/";
  return (
    <Panel title="Files" icon={<Folder className="size-3.5" />}>
      <form className="flex gap-1.5" onSubmit={(e) => (e.preventDefault(), list(path))}>
        <Input value={path} onChange={(e) => setPath(e.target.value)} className="h-8 font-mono text-xs" />
        <Button size="sm" variant="outline" type="submit">Open</Button>
        <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 text-xs hover:bg-muted/50" title="Upload into this folder">
          <Upload className="size-3.5" />
          <input type="file" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
      </form>
      {preview ? (
        <div className="flex flex-col gap-1">
          <button className="self-start text-xs text-muted-foreground hover:underline" onClick={() => setPreview(null)}>← {path}</button>
          <pre className="max-h-56 overflow-auto rounded bg-muted/40 p-2 text-xs">{preview.text}</pre>
        </div>
      ) : (
        items && (
          <div className="max-h-56 overflow-auto text-xs">
            <button className="block w-full px-1 py-0.5 text-left text-muted-foreground hover:bg-muted/50" onClick={() => list(parent)}>..</button>
            {items.map((it) => (
              <button key={it.name} className="flex w-full items-center gap-1.5 px-1 py-0.5 text-left hover:bg-muted/50" onClick={() => open(it)}>
                {it.dir ? <Folder className="size-3.5 text-muted-foreground" /> : <File className="size-3.5 text-muted-foreground" />}
                <span className="flex-1 truncate">{it.name}</span>
                {!it.dir && <span className="text-muted-foreground">{it.size < 1024 ? `${it.size} B` : it.size < 1048576 ? `${(it.size / 1024).toFixed(0)} KB` : `${(it.size / 1048576).toFixed(1)} MB`}</span>}
              </button>
            ))}
          </div>
        )
      )}
    </Panel>
  );
}

function UiTree({ run }: { run: Run }) {
  const [tree, setTree] = useState<{ app?: string; window?: string; elements: string } | null>(null);
  const read = async () => {
    try {
      setTree(await run("ui_tree", {}, 40_000));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <Panel title="UI elements (what agents click by ref)" icon={<ListTree className="size-3.5" />}>
      <Button size="sm" variant="outline" className="self-start" onClick={read}>Read the front window</Button>
      {tree && (
        <>
          <div className="text-xs text-muted-foreground">{[tree.app, tree.window].filter(Boolean).join(" · ")}</div>
          <pre className="max-h-56 overflow-auto rounded bg-muted/40 p-2 text-xs">{tree.elements || "(nothing found)"}</pre>
        </>
      )}
    </Panel>
  );
}

function Extras({ run }: { run: Run }) {
  const [clip, setClip] = useState("");
  const [target, setTarget] = useState("");
  const [apps, setApps] = useState<string | null>(null);
  const tryIt = async (f: () => Promise<void>) => {
    try {
      await f();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <Panel title="Clipboard and apps" icon={<ClipboardCopy className="size-3.5" />}>
      <div className="flex gap-1.5">
        <Input value={clip} onChange={(e) => setClip(e.target.value)} placeholder="Clipboard text" className="h-8 text-xs" />
        <Button size="sm" variant="outline" onClick={() => tryIt(async () => setClip((await run<{ text: string }>("clipboard_get")).text))}>Get</Button>
        <Button size="sm" variant="outline" onClick={() => tryIt(async () => { await run("clipboard_set", { text: clip }); toast.success("Copied on the computer"); })}>Set</Button>
      </div>
      <form className="flex gap-1.5" onSubmit={(e) => (e.preventDefault(), tryIt(async () => { await run("open", { target }); toast.success(`Opened ${target}`); }))}>
        <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Open an app, a path or a URL" className="h-8 text-xs" />
        <Button size="sm" variant="outline" type="submit">Open</Button>
      </form>
      <Button size="sm" variant="outline" className="self-start" onClick={() => tryIt(async () => setApps(JSON.stringify(await run("apps"), null, 2)))}>Running apps</Button>
      {apps && <pre className="max-h-40 overflow-auto rounded bg-muted/40 p-2 text-xs">{apps}</pre>}
    </Panel>
  );
}
