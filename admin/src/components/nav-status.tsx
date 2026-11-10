"use client";

// The terminals' and projects' status as the classic sidebar shows it (app-sidebar.tsx), shared with the desktop's
// status widget (desktop/status-widget.tsx) so both read the same: the small terminal dot, its words, sizes.

import { ClaudeGlyph, claudeGlyphState } from "@/components/claude-glyph";
import { StatusDot } from "@/components/ui/status-dot";
import type { ProjectMemory } from "@/lib/project-memory";
import type { TermStatus } from "@/store/terminals";

// Non-Claude terminal status → dot colour + optional pulse. Claude sessions use
// the glyph below instead, so only the plain shell states live here.
const TERM_DOT: Record<"idle" | "busy", { dot: string; ping: string | null }> = {
  idle: { dot: "bg-muted-foreground/40", ping: null },
  busy: { dot: "bg-emerald-500", ping: "bg-emerald-400" },
};

/** Sidebar-sized memory: 5.5G, 580M. */
export function shortBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}G`;
  return `${Math.max(1, Math.round(n / 1024 ** 2))}M`;
}

/** "5.5G in memory: dev 5.4G, postgres 40M (+1.2G agents)" */
export function memoryTitle(m: ProjectMemory): string {
  const parts = m.groups.filter((g) => g.kind !== "agent" && g.bytes >= 1024 ** 2).slice(0, 4).map((g) => `${g.label} ${shortBytes(g.bytes)}`);
  return `${shortBytes(m.bytes)} in memory${parts.length ? `: ${parts.join(", ")}` : ""}${m.agentBytes ? ` (+${shortBytes(m.agentBytes)} agents)` : ""}`;
}

/** Compact token count: 1_234 → "1.2k", 2_500_000 → "2.5M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function termLabel(status: TermStatus): string {
  switch (status) {
    case "claude-working":
      return "Claude is working";
    case "claude-input":
      return "Claude needs your input";
    case "claude-idle":
      return "Claude is idle";
    case "claude-background":
      return "Claude is idle · work running in the background";
    case "busy":
      return "Running a command";
    default:
      return "Idle";
  }
}

export function TermDot({ status }: { status: TermStatus }) {
  // Claude sessions get the CLI glyph — twinkling while active, a steady dimmed
  // spark while idle, and a "?" when blocked on input — same as the dock.
  const claude = claudeGlyphState(status);
  if (claude) {
    return (
      <span
        role="img"
        aria-label={termLabel(status)}
        title={termLabel(status)}
        className="inline-flex size-2.5 items-center justify-center"
      >
        <ClaudeGlyph state={claude} size="sm" />
      </span>
    );
  }
  const { dot, ping } = status === "busy" ? TERM_DOT.busy : TERM_DOT.idle;
  return (
    <StatusDot color={dot} pulse={ping !== null} size="sm" label={termLabel(status)} />
  );
}
