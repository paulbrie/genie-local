"use client";

import { useEffect, useRef } from "react";

import { glyphTicker } from "./glyph-ticker";

/**
 * The glyphs the Claude CLI cycles through for its "thinking" spinner — an
 * asterisk that swells and fades, from a bare dot to a full eight-point spark.
 * We animate through them (ping-pong) so an active Claude terminal twinkles the
 * same way the CLI does, for as long as it works (T169): one shared clock at 5
 * frames a second writes the glyph straight into the element (glyph-ticker.ts),
 * so a working terminal costs a tiny repaint a few times a second, nothing in a
 * hidden tab, and nothing at all once it stops. These are the CLI's actual frames, verified by sampling
 * a live `claude` pane (note the middle frame is a plain ASCII `*`, not `✳`):
 *   ·  ✢  *  ✶  ✻  ✽   (then back down)
 */
const FRAMES = ["·", "✢", "*", "✶", "✻", "✽"] as const;
const FULL = FRAMES.length - 1; // steadiest, fullest glyph (used when idle)

/** the page's one glyph clock, made on first use (browser only), stopped while the tab is hidden */
let ticker: ReturnType<typeof glyphTicker> | null = null;
function pageTicker() {
  if (!ticker) {
    ticker = glyphTicker({
      setInterval: (f, ms) => window.setInterval(f, ms),
      clearInterval: (id) => window.clearInterval(id),
      visible: () => document.visibilityState === "visible",
    });
    const t = ticker;
    document.addEventListener("visibilitychange", () => t.sync());
  }
  return ticker;
}

/** The states a Claude terminal glyph can show. */
export type ClaudeState = "active" | "idle" | "background" | "input";

/**
 * Map a terminal status to its Claude glyph state, or null when it isn't a
 * Claude session (so the caller falls back to the plain coloured dot).
 */
export function claudeGlyphState(status: string): ClaudeState | null {
  switch (status) {
    case "claude-working":
      return "active";
    case "claude-input":
      return "input";
    case "claude-idle":
      return "idle";
    case "claude-background":
      return "background";
    default:
      return null;
  }
}

const SIZE_CLS = {
  sm: "text-[11px]",
  md: "text-[15px]",
} as const;

/**
 * A Claude status glyph — no glow, three states:
 * - `active` — Claude is working: the spark twinkles through every CLI glyph
 *   while it works.
 * - `idle`   — Claude is sitting at its prompt: a steady, dimmed spark.
 * - `input`  — Claude is blocked asking you something: a "?" instead of a spark.
 *
 * Animation is skipped when the user prefers reduced motion.
 */
export function ClaudeGlyph({
  state,
  size = "sm",
  className = "",
}: {
  state: ClaudeState;
  size?: "sm" | "md";
  className?: string;
}) {
  // (working: the shared clock writes each frame into this element's data-g, shown by ::before; React keeps out of it)
  const spark = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = spark.current;
    if (state !== "active" || !el) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const stop = pageTicker().add((g) => el.setAttribute("data-g", g));
    return () => {
      stop();
      el.setAttribute("data-g", FRAMES[FULL]);
    };
  }, [state]);

  const base = `inline-flex shrink-0 items-center justify-center font-mono leading-none ${SIZE_CLS[size]} ${className}`;

  if (state === "input") {
    // Blocked on a prompt — a bold "?" reads as "your turn" at a glance.
    return (
      <span aria-hidden className={`${base} font-bold text-orange-500`}>
        ?
      </span>
    );
  }

  // active = full-strength twinkle; idle = steady, dimmed spark; background =
  // the dimmed spark breathing: idle at its prompt, work still running behind it.
  const tone =
    state === "active"
      ? "text-orange-500"
      : state === "background"
        ? "text-orange-500/70 motion-safe:animate-pulse"
        : "text-orange-500/60";
  return <span ref={spark} aria-hidden data-g={FRAMES[FULL]} className={`${base} ${tone} before:content-[attr(data-g)]`} />;
}
