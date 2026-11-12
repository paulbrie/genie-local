"use client";

import type { NavItem } from "@/components/nav-items";
import { cn } from "@/lib/utils";

/**
 * Each app's tile in the desktop (a window's title bar, a widget's header): a
 * squircle in its own gradient (lit from the top left), its glyph in white or,
 * on the light tiles, in a deep tone of the tile. The hues go round the wheel so
 * neighbours tell apart; peach is left out (it's Claude's, and Claude's own tile
 * is its terracotta).
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
  "/claude": { from: "#e9a184", to: "#c15f3c" },
  "/teams": { from: "#5eead4", to: "#0f766e" },
  "/comms": { from: "#86efac", to: "#16a34a" },
  "/agents3d": { from: "#f472b6", to: "#6d28d9" },
  "/tasks": { from: "#fda4af", to: "#e11d48" },
  "/settings": { from: "#a1a1aa", to: "#3f3f46" },
};

const FALLBACK: Tint = { from: "#a1a1aa", to: "#52525b" };

/** The tile itself; `glyph` is a lucide icon. Sizes in px. */
export function Tile({
  tint,
  glyph: Glyph,
  size,
  className,
}: {
  tint: Tint;
  glyph: NavItem["icon"];
  size: number;
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
    </span>
  );
}

/** An app's tile. */
export function AppIcon({ item, size = 56 }: { item: Pick<NavItem, "href" | "icon">; size?: number }) {
  return <Tile tint={TINTS[item.href] ?? FALLBACK} glyph={item.icon} size={size} />;
}
