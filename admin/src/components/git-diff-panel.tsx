"use client";

import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { ALargeSmall, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Input } from "@/components/ui/input";
import { parsePatch, type ParsedFile } from "@/lib/parse-patch";

// Above this many files a filter box helps find one.
const FILTER_FROM = 8;

// The code's font size, three steps as in the terminal window (cycled by "AA"),
// remembered in this browser.
const FONT_SIZES = [
  { label: "Small", px: 12 },
  { label: "Medium", px: 14 },
  { label: "Large", px: 16 },
] as const;
const FONT_KEY = "admin.diff.fontSize";
const FONT_EVENT = "admin:diff-font"; // same-tab writes don't fire "storage"
function subscribeFont(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(FONT_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(FONT_EVENT, onChange);
  };
}
function readFont(): number {
  try {
    const i = FONT_SIZES.findIndex((f) => String(f.px) === localStorage.getItem(FONT_KEY));
    return i >= 0 ? i : 0;
  } catch {
    return 0; // storage blocked: Small
  }
}

type FileEntry = ParsedFile & {
  key: string;
  path: string;
  kind: "A" | "D" | "R" | "M";
  added: number;
  removed: number;
};

function describe(file: ParsedFile, i: number): FileEntry {
  const path = file.newName ?? file.oldName ?? "unknown";
  let added = 0;
  let removed = 0;
  for (const hunk of file.hunks) {
    // Skip each hunk's "@@ … @@" header line.
    for (const line of hunk.split("\n").slice(1)) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  const kind = !file.oldName
    ? "A"
    : !file.newName
      ? "D"
      : file.oldName !== file.newName
        ? "R"
        : "M";
  return { ...file, key: `${path}-${i}`, path, kind, added, removed };
}

const KIND_STYLE: Record<FileEntry["kind"], { label: string; className: string }> = {
  A: { label: "added", className: "text-emerald-600 dark:text-emerald-400" },
  D: { label: "deleted", className: "text-red-600 dark:text-red-400" },
  R: { label: "renamed", className: "text-sky-600 dark:text-sky-400" },
  M: { label: "modified", className: "text-amber-600 dark:text-amber-400" },
};

/**
 * A commit's patch, one collapsible row per file (collapsed at first): the
 * rows double as the commit's file index, with +/- counts. Open a file by
 * clicking its row (its header then sticks while you scroll its diff), or
 * expand / collapse them all; a filter box appears for larger commits. A
 * file's diff is only rendered once it's opened.
 */
export function GitDiffPanel({ patch }: { patch: string }) {
  const files = useMemo(() => parsePatch(patch).map(describe), [patch]);
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? "dark" : "light";

  const [open, setOpen] = useState<Set<string>>(new Set());
  // the saved size (Small on the server and until hydrated)
  const fontIdx = useSyncExternalStore(subscribeFont, readFont, () => 0);
  const font = FONT_SIZES[fontIdx];
  const cycleFont = () => {
    try {
      localStorage.setItem(FONT_KEY, String(FONT_SIZES[(fontIdx + 1) % FONT_SIZES.length].px));
    } catch {
      /* storage blocked: not remembered */
    }
    window.dispatchEvent(new Event(FONT_EVENT));
  };
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
  }, [files, filter]);

  const totals = useMemo(
    () => files.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 }),
    [files],
  );

  // Split only when the PANEL (not the window) fits two columns of code: next
  // to the commit list it's ~500px, where split wraps every line.
  const ref = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  // The wrapper only exists once there are files to show.
  const hasFiles = files.length > 0;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= 900));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasFiles]);

  function toggle(key: string) {
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (files.length === 0)
    return <p className="p-4 text-sm text-muted-foreground">No file changes in this commit.</p>;

  const allOpen = shown.length > 0 && shown.every((f) => open.has(f.key));

  return (
    <div ref={ref}>
      {/* Summary + controls, pinned above the file rows. */}
      <div className="sticky top-0 z-20 flex h-10 items-center gap-2 border-b bg-background px-1 text-xs">
        <span className="shrink-0 text-muted-foreground">
          {files.length} {files.length === 1 ? "file" : "files"}
        </span>
        <span className="shrink-0 font-mono text-emerald-600 dark:text-emerald-400">+{totals.added}</span>
        <span className="shrink-0 font-mono text-red-600 dark:text-red-400">−{totals.removed}</span>
        {files.length > FILTER_FROM && (
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files…"
            aria-label="Filter files"
            className="h-7 min-w-0 flex-1 text-xs md:text-xs"
          />
        )}
        <button
          type="button"
          onClick={cycleFont}
          aria-label="Font size"
          title={`Font size: ${font.label} (${font.px}px) — click to cycle`}
          className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ALargeSmall className="size-3.5" />
          {font.label}
        </button>
        <button
          type="button"
          onClick={() =>
            setOpen((s) => {
              const next = new Set(s);
              for (const f of shown) {
                if (allOpen) next.delete(f.key);
                else next.add(f.key);
              }
              return next;
            })
          }
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {allOpen ? <ChevronsDownUp className="size-3.5" /> : <ChevronsUpDown className="size-3.5" />}
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">No file matches “{filter}”.</p>
      ) : (
        <ul className="divide-y">
          {shown.map((file) => {
            const isOpen = open.has(file.key);
            const slash = file.path.lastIndexOf("/");
            const kind = KIND_STYLE[file.kind];
            return (
              <li key={file.key} data-file={file.path}>
                <button
                  type="button"
                  onClick={() => toggle(file.key)}
                  aria-expanded={isOpen}
                  title={file.kind === "R" ? `${file.oldName} → ${file.newName}` : file.path}
                  className={`flex w-full items-center gap-1.5 px-1 py-1.5 text-left text-xs hover:bg-muted/60 ${
                    // An open file's header sticks under the summary bar.
                    isOpen ? "sticky top-10 z-10 border-b bg-muted" : ""
                  }`}
                >
                  {isOpen ? (
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className={`w-3 shrink-0 font-mono font-semibold ${kind.className}`} title={kind.label}>
                    {file.kind}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono" dir="rtl">
                    {/* rtl truncates from the left: the file name stays visible. */}
                    <bdi>
                      {slash >= 0 && (
                        <span className="text-muted-foreground">{file.path.slice(0, slash + 1)}</span>
                      )}
                      <span className="font-medium">{file.path.slice(slash + 1)}</span>
                    </bdi>
                  </span>
                  {file.binary ? (
                    <span className="shrink-0 text-muted-foreground">binary</span>
                  ) : (
                    <span className="shrink-0 font-mono tabular-nums">
                      <span className="text-emerald-600 dark:text-emerald-400">+{file.added}</span>{" "}
                      <span className="text-red-600 dark:text-red-400">−{file.removed}</span>
                    </span>
                  )}
                </button>
                {isOpen &&
                  (file.binary || file.hunks.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">
                      {file.binary ? "Binary file — diff not shown." : "No textual changes (mode/rename only)."}
                    </p>
                  ) : (
                    <DiffView
                      data={{
                        oldFile: { fileName: file.oldName, fileLang: file.lang },
                        newFile: { fileName: file.newName, fileLang: file.lang },
                        // @git-diff-view renders nothing for bare "@@" hunks: it needs
                        // the file's ---/+++ header, which parsePatch splits off.
                        hunks: [
                          `--- ${file.oldName ? `a/${file.oldName}` : "/dev/null"}\n` +
                            `+++ ${file.newName ? `b/${file.newName}` : "/dev/null"}\n` +
                            file.hunks.join("\n"),
                        ],
                      }}
                      diffViewMode={wide ? DiffModeEnum.Split : DiffModeEnum.Unified}
                      diffViewFontSize={font.px}
                      diffViewTheme={theme}
                      diffViewHighlight
                      diffViewWrap
                    />
                  ))}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
