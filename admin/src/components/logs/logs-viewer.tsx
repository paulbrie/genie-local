"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BASE_PATH } from "@/lib/config";
import { formatBytes, formatRelativeTime } from "@/lib/format";

const POLL_MS = 3000;

type LogFile = { path: string; size: number; mtimeMs: number };
type LogTail = {
  path: string;
  size: number;
  mtimeMs: number;
  returnedBytes: number;
  truncated: boolean;
  content: string;
};

const BYTE_OPTIONS = [
  { label: "64 KB", value: String(64 * 1024) },
  { label: "256 KB", value: String(256 * 1024) },
  { label: "1 MB", value: String(1024 * 1024) },
  { label: "4 MB", value: String(4 * 1024 * 1024) },
];

export function LogsViewer() {
  const [files, setFiles] = useState<LogFile[]>([]);
  const [listError, setListError] = useState(false);

  // Deep-link support: /admin/logs?file=projects/<slug>.log opens that file, and
  // ?filter=<text> pre-sets the sidebar filter so the list is narrowed to the
  // relevant logs (callers pass the app/run group — see logFilter()).
  const [filter, setFilter] = useState(() =>
    typeof window === "undefined"
      ? ""
      : (new URLSearchParams(window.location.search).get("filter") ?? ""),
  );
  const [selected, setSelected] = useState<string | null>(() =>
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("file"),
  );
  const [tail, setTail] = useState<LogTail | null>(null);
  const [tailError, setTailError] = useState<string | null>(null);
  const [bytes, setBytes] = useState(String(256 * 1024));
  const [autoRefresh, setAutoRefresh] = useState(true);

  const preRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  const loadList = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_PATH}/api/logs`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const json: { files: LogFile[] } = await res.json();
      setFiles(json.files);
      setListError(false);
    } catch {
      setListError(true);
    }
  }, []);

  const loadTail = useCallback(async (file: string, byteWindow: string) => {
    try {
      const res = await fetch(
        `${BASE_PATH}/api/logs/tail?file=${encodeURIComponent(file)}&bytes=${byteWindow}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? String(res.status));
      }
      const json: LogTail = await res.json();
      setTail(json);
      setTailError(null);
    } catch (e) {
      setTail(null);
      setTailError(e instanceof Error ? e.message : "failed to read");
    }
  }, []);

  // Initial + polled file list.
  useEffect(() => {
    loadList();
    if (!autoRefresh) return;
    const id = setInterval(loadList, POLL_MS);
    return () => clearInterval(id);
  }, [loadList, autoRefresh]);

  // Load + poll the selected file's tail.
  useEffect(() => {
    if (!selected) return;
    loadTail(selected, bytes);
    if (!autoRefresh) return;
    const id = setInterval(() => loadTail(selected, bytes), POLL_MS);
    return () => clearInterval(id);
  }, [selected, bytes, autoRefresh, loadTail]);

  // Auto-scroll to bottom (tail -f behaviour) while the user is at the bottom.
  useEffect(() => {
    const el = preRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [tail]);

  function onContentScroll() {
    const el = preRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    followRef.current = nearBottom;
  }

  function selectFile(p: string) {
    followRef.current = true;
    setSelected(p);
    setTail(null);
    setTailError(null);
  }

  const q = filter.trim().toLowerCase();
  const shown = q
    ? files.filter((f) => f.path.toLowerCase().includes(q))
    : files;

  return (
    <div className="flex h-[calc(100vh-11rem)] gap-4">
      {/* File list */}
      <aside className="flex w-72 shrink-0 flex-col gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter logs…"
          className="h-8"
        />
        <div className="min-h-0 flex-1 overflow-auto rounded-md border">
          {listError ? (
            <p className="p-3 text-sm text-destructive">Failed to list logs.</p>
          ) : shown.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              {files.length === 0 ? "No log files found." : "No matches."}
            </p>
          ) : (
            <ul className="divide-y">
              {shown.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    onClick={() => selectFile(f.path)}
                    className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-muted/60 ${
                      selected === f.path ? "bg-muted" : ""
                    }`}
                  >
                    <span className="w-full truncate font-mono text-xs">
                      {f.path}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {formatBytes(f.size)} · {formatRelativeTime(new Date(f.mtimeMs))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {shown.length} of {files.length} file{files.length === 1 ? "" : "s"}
        </p>
      </aside>

      {/* Content */}
      <section className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="min-w-0 flex-1 truncate font-mono text-sm">
            {selected ?? "Select a log file"}
          </span>
          <div className="flex items-center gap-2">
            <Label htmlFor="bytes" className="text-xs text-muted-foreground">
              Tail
            </Label>
            <Select value={bytes} onValueChange={(v) => v && setBytes(v)}>
              <SelectTrigger id="bytes" className="h-8 w-[110px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BYTE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              checked={autoRefresh}
              onCheckedChange={(v) => setAutoRefresh(v === true)}
            />
            Auto-refresh
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={!selected}
            onClick={() => selected && loadTail(selected, bytes)}
          >
            Refresh
          </Button>
        </div>

        <div
          ref={preRef}
          onScroll={onContentScroll}
          className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/20 p-3"
        >
          {!selected ? (
            <p className="text-sm text-muted-foreground">
              Pick a log on the left to view its contents.
            </p>
          ) : tailError ? (
            <p className="text-sm text-destructive">Error: {tailError}</p>
          ) : tail ? (
            tail.content ? (
              <pre className="font-mono text-xs leading-relaxed whitespace-pre">
                {tail.content}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">(empty file)</p>
            )
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
        </div>

        {tail && (
          <p className="text-[11px] text-muted-foreground">
            Showing last {formatBytes(tail.returnedBytes)} of{" "}
            {formatBytes(tail.size)}
            {tail.truncated ? " (truncated)" : ""} · updated{" "}
            {formatRelativeTime(new Date(tail.mtimeMs))}
          </p>
        )}
      </section>
    </div>
  );
}
