"use client";

import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useState } from "react";

import { parsePatch } from "@/lib/parse-patch";

/**
 * Render every file in a commit's patch with @git-diff-view. The raw patch is
 * split per-file (parsePatch) and each file gets its own DiffView. Unified mode
 * on narrow screens, split on wide, matching the surrounding tooling.
 */
export function GitDiffPanel({ patch }: { patch: string }) {
  const files = useMemo(() => parsePatch(patch), [patch]);
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? "dark" : "light";

  // Split view only helps on wide viewports; fall back to unified when narrow.
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  if (files.length === 0)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No file changes in this commit.
      </p>
    );

  return (
    <div className="space-y-4">
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
                  hunks: file.hunks,
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
