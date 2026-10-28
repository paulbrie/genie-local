"use client";

import { useState } from "react";
import Link from "next/link";
import { Boxes } from "lucide-react";
import { useSubject } from "subjecto/react";

import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Z_GLOBAL_CONTROLS } from "@/lib/z-layers";
import { projectMemory } from "@/store/project-memory";

/**
 * "Projects 9.5 GB" in the top bar: the memory every project's processes and
 * containers use together, and on hover (or focus) each project's share, its
 * agents apart. The breakdown is fixed-positioned: the bar's metrics scroll
 * sideways and would clip it.
 */
export function ProjectsMemoryBadge() {
  const [status] = useSubject(projectMemory);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  if (!status) return null;
  const total = status.projects.reduce((n, p) => n + p.bytes, 0);
  const agents = status.projects.reduce((n, p) => n + p.agentBytes, 0);
  const show = (e: React.SyntheticEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAt({ x: r.left, y: r.bottom + 6 });
  };
  return (
    <div
      className="flex shrink-0 items-center"
      onMouseEnter={show}
      onMouseLeave={() => setAt(null)}
      onFocus={show}
      onBlur={() => setAt(null)}
    >
      <Link href="/projects" className="flex items-center gap-1.5 rounded px-1 text-xs whitespace-nowrap hover:bg-accent/50" data-testid="projects-memory">
        <Boxes className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-muted-foreground">Projects</span>
        <span className="font-mono tabular-nums">{formatBytes(total)}</span>
      </Link>
      {at && (
        <div
          role="tooltip"
          style={{ left: at.x, top: at.y, zIndex: Z_GLOBAL_CONTROLS }}
          className="fixed w-72 rounded-lg border bg-popover p-2 text-xs text-popover-foreground shadow-xl"
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
          {agents > 0 && (
            <p className="mt-1 border-t pt-1 text-muted-foreground">
              Agents (Claude sessions) {formatBytes(agents)}, not in the total.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
