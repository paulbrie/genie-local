"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Boxes } from "lucide-react";
import { useSubject } from "subjecto/react";

import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Z_GLOBAL_CONTROLS } from "@/lib/z-layers";
import { projectMemory } from "@/store/project-memory";
import { liveTerminals } from "@/store/terminals";

/**
 * "Projects 9.5 GB" in the top bar: the memory every project's processes and
 * containers use together, and on hover (or focus) each project's share, its
 * agents apart, and each terminal's. The breakdown is portalled to <body>: inside the top bar it
 * sat in the bar's stacking context (its backdrop-blur makes one), under whatever the page drew
 * later, whatever its z-index; and fixed-positioned, as the bar's metrics scroll sideways. It
 * closes a moment after the pointer leaves, so the pointer can cross into it and scroll it.
 */
export function ProjectsMemoryBadge() {
  const [status] = useSubject(projectMemory);
  const [terms] = useSubject(liveTerminals);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keep = () => clearTimeout(closing.current);
  const close = () => {
    clearTimeout(closing.current);
    closing.current = setTimeout(() => setAt(null), 150);
  };
  useEffect(() => () => clearTimeout(closing.current), []);
  if (!status) return null;
  const total = status.projects.reduce((n, p) => n + p.bytes, 0);
  const agents = status.projects.reduce((n, p) => n + p.agentBytes, 0);
  const show = (e: React.SyntheticEvent<HTMLElement>) => {
    keep();
    const r = e.currentTarget.getBoundingClientRect();
    // (its right edge under the badge's: the badge sits near the right of the bar)
    setAt({ x: window.innerWidth - r.right, y: r.bottom + 6 });
  };
  return (
    <div
      className="flex shrink-0 items-center"
      onMouseEnter={show}
      onMouseLeave={close}
      onFocus={show}
      onBlur={close}
    >
      <Link href="/projects" className="flex items-center gap-1.5 rounded px-1 text-xs whitespace-nowrap hover:bg-accent/50" data-testid="projects-memory">
        <Boxes className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-muted-foreground">Projects</span>
        <span className="font-mono tabular-nums">{formatBytes(total)}</span>
      </Link>
      {at && createPortal(
        <div
          role="tooltip"
          onMouseEnter={keep}
          onMouseLeave={close}
          style={{ right: Math.max(8, at.x), top: at.y, zIndex: Z_GLOBAL_CONTROLS, maxHeight: `calc(100vh - ${at.y + 8}px)` }}
          className="fixed w-80 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border bg-popover p-2 text-xs text-popover-foreground shadow-xl"
        >
          <div className="mb-1 flex justify-between text-muted-foreground">
            <span>Memory by project</span>
            <span>{formatBytes(status.server.availableBytes)} free of {formatBytes(status.server.totalBytes)}</span>
          </div>
          {status.projects.length === 0 && <p className="text-muted-foreground">Nothing running in a project.</p>}
          <ul className="space-y-0.5">
            {status.projects.map((p) => {
              const limit = status.limits[p.slug];
              const over = !!limit && p.bytes > limit * 1024 * 1024;
              return (
                <li key={p.slug} className="flex items-baseline gap-2">
                  <span className="truncate">{p.slug}</span>
                  <span className={cn("ml-auto font-mono tabular-nums", over && "font-semibold text-destructive")}>{p.bytes > 0 ? formatBytes(p.bytes) : "—"}</span>
                  {p.agentBytes > 0 && <span className="shrink-0 font-mono text-muted-foreground tabular-nums" title="Claude sessions working in it">+{formatBytes(p.agentBytes)} agents</span>}
                </li>
              );
            })}
          </ul>
          {terms.some((t) => t.memBytes) && (
            <>
              {/* (a terminal's memory is also its project's when it runs there: shown for itself, not added up) */}
              <div className="mt-2 mb-1 border-t pt-1 text-muted-foreground">Terminals</div>
              <ul className="space-y-0.5" data-testid="terminals-memory">
                {[...terms]
                  .filter((t) => t.memBytes)
                  .sort((a, b) => (b.memBytes ?? 0) - (a.memBytes ?? 0))
                  .map((t) => (
                    <li key={t.name} className="flex items-baseline gap-2">
                      <span className="truncate">{t.name}</span>
                      <span className="ml-auto font-mono tabular-nums">{formatBytes(t.memBytes ?? 0)}</span>
                    </li>
                  ))}
              </ul>
            </>
          )}
          {agents > 0 && (
            <p className="mt-1 border-t pt-1 text-muted-foreground">
              Agents (Claude sessions) {formatBytes(agents)}, not in the total.
            </p>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
