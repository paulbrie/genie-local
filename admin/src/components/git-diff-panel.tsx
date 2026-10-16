"use client";

import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef, useState } from "react";

import { parsePatch } from "@/lib/parse-patch";

/**
 * Render every file in a commit's patch with @git-diff-view. The raw patch is
 * split per-file (parsePatch) and each file gets its own DiffView. Unified mode
 * when the panel is narrow, split when it has room for two columns of code.
 */
export function GitDiffPanel({ patch }: { patch: string }) {
  const files = useMemo(() => parsePatch(patch), [patch]);
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? "dark" : "light";

  // Split only when the PANEL (not the window) fits two columns of code: next
  // to the commit list it's ~500px, where split wraps every line.
  const ref = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  // The wrapper only exists once there are files to show.
  const hasFiles = files.length > 0;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) =>
      setWide(entry.contentRect.width >= 900),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasFiles]);

  if (files.length === 0)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No file changes in this commit.
      </p>
    );

  return (
    <div ref={ref} className="space-y-4">
      {files.map((file, i) => {
        const name = file.newName ?? file.oldName ?? "unknown";
        const renamed =
          file.oldName && file.newName && file.oldName !== file.newName;
        return (
          <div key={`${name}-${i}`} className="overflow-hidden rounded-md border">
            <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1.5">
              <span className="truncate font-mono text-xs">
                {renamed ? `${file.oldName} → ${file.newName}` : name}
              </span>
              {file.binary && (
                <span className="text-xs text-muted-foreground">binary</span>
              )}
            </div>
            {file.binary || file.hunks.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {file.binary
                  ? "Binary file — diff not shown."
                  : "No textual changes (mode/rename only)."}
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
                diffViewTheme={theme}
                diffViewHighlight
                diffViewWrap
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
