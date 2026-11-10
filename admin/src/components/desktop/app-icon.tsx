"use client";

import { Code2, FolderGit2, LayoutGrid } from "lucide-react";

import type { NavItem } from "@/components/nav-items";
import { cn } from "@/lib/utils";

/**
 * Each app's tile on the desktop: a squircle in its own gradient (lit from the
 * top left), its glyph in white or, on the light tiles, in a deep tone of the
 * tile. The hues go round the wheel so neighbours tell apart; peach is left out
 * (it's Claude's, and Claude's own tile is its terracotta).
 */
type Tint = {
  from: string;
  to: string;
  glyph?: string;
  /**
   * A pale tile with a dark glyph: no dark shadow under the glyph (on a pale ground it doubles a thin glyph's
   * edges, which reads as pixelated), a faint light one instead.
   */
  light?: boolean;
};

const TINTS: Record<string, Tint> = {
  "/": { from: "#818cf8", to: "#4338ca" },
  "/projects": { from: "#fcd34d", to: "#ea580c" },
  "/terminals": { from: "#3f3f46", to: "#09090b", glyph: "#4ade80" },
  "/boards": { from: "#fef08a", to: "#facc15", glyph: "#854d0e", light: true },
  "/files": { from: "#7dd3fc", to: "#0369a1" },
  "/db": { from: "#6ee7b7", to: "#047857" },
  "/processes": { from: "#fca5a5", to: "#dc2626" },
  "/chrome": { from: "#ffffff", to: "#dbe1ea", glyph: "#2563eb", light: true },
  "/browsers": { from: "#f0abfc", to: "#a21caf" },
  "/agents": { from: "#c4b5fd", to: "#6d28d9" },
  "/docker": { from: "#1e40af", to: "#0b1a42", glyph: "#7dd3fc" },
  "/services": { from: "#94a3b8", to: "#334155" },
  "/nginx": { from: "#22c55e", to: "#14532d" },
  "/firewall": { from: "#fdba74", to: "#c2410c" },
  "/railway": { from: "#3b3486", to: "#13112e", glyph: "#e9d5ff" },
  "/diagrams": { from: "#67e8f9", to: "#0e7490" },
  "/recipes": { from: "#d9f99d", to: "#4d7c0f" },
  "/logs": { from: "#d6d3d1", to: "#57534e" },
  "/logins": { from: "#fde68a", to: "#b45309" },
  "/users": { from: "#93c5fd", to: "#1d4ed8" },
  "/claude": { from: "#e9a184", to: "#c15f3c" },
  "/teams": { from: "#5eead4", to: "#0f766e" },
  "/comms": { from: "#86efac", to: "#16a34a" },
  "/agents3d": { from: "#f472b6", to: "#6d28d9" },
  "/tasks": { from: "#fda4af", to: "#e11d48" },
  "/vscode": { from: "#4fb3ff", to: "#0065a9" },
  launchpad: { from: "#e4e4e7", to: "#a1a1aa", glyph: "#3f3f46", light: true },
};

const FALLBACK: Tint = { from: "#a1a1aa", to: "#52525b" };

/** A project's tile colour, steady per name (the folder hues of the palette above). */
const PROJECT_TINTS: Tint[] = ["/projects", "/files", "/db", "/agents", "/diagrams", "/tasks", "/teams", "/browsers"].map(
  (k) => TINTS[k],
);
function projectTint(slug: string): Tint {
  let h = 0;
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PROJECT_TINTS[h % PROJECT_TINTS.length];
}

/** The tile itself; `glyph` is a lucide icon. Sizes in px. */
export function Tile({
  tint,
  glyph: Glyph,
  size,
  badge,
  dot,
  className,
}: {
  tint: Tint;
  glyph: NavItem["icon"];
  size: number;
  /** A count in the corner (a notification badge). */
  badge?: number | string | null;
  /** A small green light in the corner: running. */
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <span
        aria-hidden
        className="absolute inset-0 overflow-hidden rounded-[24%] shadow-[0_1px_2px_rgb(0_0_0/0.25),0_6px_14px_-4px_rgb(0_0_0/0.35)] ring-1 ring-black/10 ring-inset dark:ring-white/10"
        style={{ background: `linear-gradient(150deg, ${tint.from}, ${tint.to})` }}
      >
        {/* the gloss: light from the top, fading by the middle */}
        <span className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/35 to-transparent" />
      </span>
      <Glyph
        aria-hidden
        strokeWidth={1.9}
        className={cn("relative", tint.light ? "drop-shadow-[0_1px_0_rgb(255_255_255/0.55)]" : "drop-shadow-[0_1px_1px_rgb(0_0_0/0.25)]")}
        style={{ width: size * 0.5, height: size * 0.5, color: tint.glyph ?? "#ffffff" }}
      />
      {badge != null && badge !== 0 && (
        <span
          className="absolute -top-1.5 -right-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] leading-none font-semibold text-white tabular-nums shadow-sm ring-2 ring-white/70 dark:ring-black/40"
        >
          {badge}
        </span>
      )}
      {dot && (
        <span className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-zinc-900" />
      )}
    </span>
  );
}

/** An app's tile. */
export function AppIcon({ item, size = 56, badge }: { item: Pick<NavItem, "href" | "icon">; size?: number; badge?: number | string | null }) {
  return <Tile tint={TINTS[item.href] ?? FALLBACK} glyph={item.icon} size={size} badge={badge} />;
}

/** VS Code's tile (it opens outside the admin). */
export function VsCodeIcon({ size = 56 }: { size?: number }) {
  return <Tile tint={TINTS["/vscode"]} glyph={Code2} size={size} />;
}

/** The Launchpad's tile: every app. */
export function LaunchpadIcon({ size = 56 }: { size?: number }) {
  return <Tile tint={TINTS.launchpad} glyph={LayoutGrid} size={size} />;
}

/** A project's tile: a folder in the project's colour, lit when one of its apps runs. */
export function ProjectIcon({ slug, size = 56, running }: { slug: string; size?: number; running?: boolean }) {
  return <Tile tint={projectTint(slug)} glyph={FolderGit2} size={size} dot={running} />;
}
