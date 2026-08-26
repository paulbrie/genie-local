"use client";

import { useEffect, useState } from "react";

/**
 * The glyphs the Claude CLI cycles through for its "thinking" spinner — an
 * asterisk that swells and fades, from a bare dot to a full eight-point spark.
 * We animate through them (ping-pong) so an active Claude terminal twinkles the
 * same way the CLI does. These are the CLI's actual frames, verified by sampling
 * a live `claude` pane (note the middle frame is a plain ASCII `*`, not `✳`):
 *   ·  ✢  *  ✶  ✻  ✽   (then back down)
 */
const FRAMES = ["·", "✢", "*", "✶", "✻", "✽"] as const;
const FULL = FRAMES.length - 1; // steadiest, fullest glyph (used when idle)
const FRAME_MS = 110;

/** The three states a Claude terminal glyph can show. */
export type ClaudeState = "active" | "idle" | "input";

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
 * - `active` — Claude is working: the spark twinkles through every CLI glyph.
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
  const [frame, setFrame] = useState(FULL);

  useEffect(() => {
    if (state !== "active") return;
    const reduced =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false;
    if (reduced) return;
    // Ping-pong through the frames for the swell-and-fade twinkle. Start at -1
    // so the first tick lands on the bare dot.
    let idx = -1;
    let dir = 1;
    const id = window.setInterval(() => {
      idx += dir;
      if (idx >= FULL) dir = -1;
      else if (idx <= 0) dir = 1;
      setFrame(idx);
    }, FRAME_MS);
    return () => window.clearInterval(id);
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

  // active = full-strength twinkle; idle = steady, dimmed spark.
  const tone = state === "active" ? "text-orange-500" : "text-orange-500/60";
  const shown = state === "active" ? FRAMES[frame] : FRAMES[FULL];
  return (
    <span aria-hidden className={`${base} ${tone}`}>
      {shown}
    </span>
  );
}
