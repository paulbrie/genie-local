"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BASE_PATH } from "@/lib/config";
import { formatRelativeTime } from "@/lib/format";

type MemoryFile = {
  path: string;
  project: string;
  title: string;
  description: string | null;
  type: string | null;
  size: number;
  mtimeMs: number;
};

export function MemoriesPanel() {
  const [memories, setMemories] = useState<MemoryFile[]>([]);
  const [listError, setListError] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<MemoryFile | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_PATH}/api/claude/memories`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(String(res.status));
      const json: { memories: MemoryFile[] } = await res.json();
      setMemories(json.memories);
      setListError(false);
    } catch {
      setListError(true);
    }
  }, []);

  const loadContent = useCallback(async (m: MemoryFile) => {
    setContent(null);
    setContentError(null);
    try {
      const res = await fetch(
        `${BASE_PATH}/api/claude/memories/read?path=${encodeURIComponent(m.path)}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? String(res.status));
      }
      const json: { content: string } = await res.json();
      setContent(json.content);
    } catch (e) {
      setContentError(e instanceof Error ? e.message : "failed to read");
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  function select(m: MemoryFile) {
    setSelected(m);
    loadContent(m);
  }

  const q = filter.trim().toLowerCase();
  const shown = q
    ? memories.filter(
        (m) =>
          m.title.toLowerCase().includes(q) ||
          (m.description ?? "").toLowerCase().includes(q) ||
          m.path.toLowerCase().includes(q),
      )
    : memories;

  return (
    <div className="flex h-[calc(100vh-14rem)] gap-4">
      {/* Memory list */}
      <aside className="flex w-96 shrink-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter memories…"
            className="h-8"
          />
          <Button size="sm" variant="outline" onClick={loadList}>
            Refresh
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto rounded-md border">
          {listError ? (
            <p className="p-3 text-sm text-destructive">
              Failed to list memories.
            </p>
          ) : shown.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              {memories.length === 0 ? "No memories found." : "No matches."}
            </p>
          ) : (
            <ul className="divide-y">
              {shown.map((m) => (
                <li key={m.path}>
                  <button
                    type="button"
                    onClick={() => select(m)}
                    className={`flex w-full flex-col items-start gap-1 px-3 py-2 text-left hover:bg-muted/60 ${
                      selected?.path === m.path ? "bg-muted" : ""
                    }`}
                  >
                    <span className="flex w-full items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {m.title}
                      </span>
                      {m.type && (
                        <Badge
                          variant="secondary"
                          className="h-4 shrink-0 px-1 text-[10px]"
                        >
                          {m.type}
                        </Badge>
                      )}
                    </span>
                    {m.description && (
                      <span className="line-clamp-2 text-[11px] text-muted-foreground">
                        {m.description}
                      </span>
                    )}
                    <span className="text-[11px] text-muted-foreground">
                      {formatRelativeTime(new Date(m.mtimeMs))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {shown.length} of {memories.length} memor
          {memories.length === 1 ? "y" : "ies"}
        </p>
      </aside>

      {/* Content */}
      <section className="flex min-w-0 flex-1 flex-col gap-2">
        {!selected ? (
          <div className="grid flex-1 place-items-center rounded-md border text-sm text-muted-foreground">
            Pick a memory on the left to read it.
          </div>
        ) : (
          <>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{selected.title}</p>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {selected.path}
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/20 p-3">
              {contentError ? (
                <p className="text-sm text-destructive">Error: {contentError}</p>
              ) : content != null ? (
                <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                  {content}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">Loading…</p>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
