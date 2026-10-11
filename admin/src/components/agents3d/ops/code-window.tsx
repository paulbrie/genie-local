"use client";

import { Editor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { BASE_PATH } from "@/lib/config";

/**
 * Read-only code windows for the Ops view (T197): a file of the map, right-clicked, in Monaco, in a window that
 * moves (drag its title) and resizes (its corner), several at once, closed with × or Esc (the frontmost). Monaco
 * comes from the admin's own bundle, not a CDN, and this whole module is loaded only when the first window opens.
 * The file comes from /api/agents3d/file, which reads only what the map shows and refuses secrets
 * (lib/repo-file-guard.ts); a refusal shows in the window.
 */

// (Monaco from the bundle, its workers too: syntax colouring by the file's extension, nothing fetched from elsewhere)
loader.config({ monaco });
if (typeof self !== "undefined") {
  const worker = (label: string) => {
    if (label === "typescript" || label === "javascript") return new Worker(new URL("./monaco/ts.worker.ts", import.meta.url), { type: "module" });
    if (label === "json") return new Worker(new URL("./monaco/json.worker.ts", import.meta.url), { type: "module" });
    if (label === "css" || label === "scss" || label === "less") return new Worker(new URL("./monaco/css.worker.ts", import.meta.url), { type: "module" });
    if (label === "html" || label === "handlebars" || label === "razor") return new Worker(new URL("./monaco/html.worker.ts", import.meta.url), { type: "module" });
    return new Worker(new URL("./monaco/editor.worker.ts", import.meta.url), { type: "module" });
  };
  (self as unknown as { MonacoEnvironment: { getWorker: (id: string, label: string) => Worker } }).MonacoEnvironment = { getWorker: (_id, label) => worker(label) };
}

export type CodeWin = { id: number; repo: string; repoName: string; path: string };
type Loaded = { text: string; bytes: number } | { error: string } | null;

export default function CodeWindows({ wins, onClose }: { wins: CodeWin[]; onClose: (id: number) => void }) {
  // (the order front to back: the last raised is frontmost; Esc closes it)
  const [order, setOrder] = useState<number[]>([]);
  const front = [...order].reverse().find((id) => wins.some((w) => w.id === id)) ?? wins[wins.length - 1]?.id;
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    if (front === undefined) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current(front);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [front]);
  return (
    <>
      {wins.map((w, i) => (
        <CodeWindow key={w.id} win={w} n={i} front={w.id === front} z={60 + Math.max(0, order.indexOf(w.id))} onRaise={() => setOrder((o) => [...o.filter((x) => x !== w.id), w.id])} onClose={() => onClose(w.id)} />
      ))}
    </>
  );
}

function CodeWindow({ win, n, front, z, onRaise, onClose }: { win: CodeWin; n: number; front: boolean; z: number; onRaise: () => void; onClose: () => void }) {
  const [file, setFile] = useState<Loaded>(null);
  const [at, setAt] = useState(() => ({ x: 140 + (n % 6) * 32, y: 90 + (n % 6) * 32 }));
  useEffect(() => {
    let gone = false;
    const q = new URLSearchParams({ repo: win.repo, path: win.path });
    fetch(`${BASE_PATH}/api/agents3d/file?${q}`, { cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json()) as { text?: string; bytes?: number; error?: string };
        if (!gone) setFile(r.ok && typeof j.text === "string" ? { text: j.text, bytes: j.bytes ?? j.text.length } : { error: j.error ?? `HTTP ${r.status}` });
      })
      .catch((e) => !gone && setFile({ error: e instanceof Error ? e.message : String(e) }));
    return () => {
      gone = true;
    };
  }, [win.repo, win.path]);
  // (dragged by its title bar)
  const drag = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const sx = e.clientX - at.x, sy = e.clientY - at.y;
    const move = (m: PointerEvent) => setAt({ x: Math.max(0, Math.min(window.innerWidth - 120, m.clientX - sx)), y: Math.max(0, Math.min(window.innerHeight - 40, m.clientY - sy)) });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      role="dialog"
      aria-label={`${win.path} (read only)`}
      onPointerDown={onRaise}
      style={{ left: at.x, top: at.y, zIndex: z }}
      className={`fixed flex h-[28rem] max-h-[90vh] min-h-[10rem] w-[46rem] max-w-[94vw] min-w-[20rem] resize flex-col overflow-hidden rounded-lg border bg-[#1e1e1e] text-white shadow-2xl ${front ? "border-sky-500/70" : "border-white/15"}`}
    >
      <div onPointerDown={drag} className="flex cursor-move items-center gap-2 border-b border-white/10 bg-black/40 px-2 py-1 text-xs select-none">
        <span className="shrink-0 text-white/50">{win.repoName}</span>
        <span className="truncate font-mono" title={win.path}>{win.path}</span>
        <span className="ml-auto shrink-0 text-white/40">{file && "text" in file ? `${Math.max(1, Math.round(file.bytes / 1024))} kB · read only` : ""}</span>
        <button type="button" onClick={onClose} aria-label="Close" title="Close (Esc)" className="rounded p-0.5 text-white/70 hover:bg-white/10 hover:text-white">
          <X className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {!file ? (
          <p className="p-3 text-xs text-white/60">Loading…</p>
        ) : "error" in file ? (
          <p className="p-3 text-sm text-amber-300">{file.error}</p>
        ) : (
          <Editor
            path={`${win.repo}/${win.path}`}
            defaultValue={file.text}
            theme="vs-dark"
            options={{ readOnly: true, domReadOnly: true, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, renderValidationDecorations: "off", automaticLayout: true }}
          />
        )}
      </div>
    </div>
  );
}
