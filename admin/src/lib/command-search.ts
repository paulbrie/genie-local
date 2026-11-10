// The command palette's search (⌘K / Ctrl+K, components/command-palette.tsx): what each typed word matches, and the
// order results come in. Pure, so command-search.test.ts runs it directly.

export type CommandKind = "page" | "project" | "tab" | "terminal" | "action";

export type Command = {
  id: string;
  kind: CommandKind;
  label: string;
  /** shown muted beside the label (a status, a path) */
  detail?: string;
  /** more words it answers to, not shown */
  keywords?: string;
};

// (same score: pages first, then projects, a project's tabs, terminals, actions)
const KIND_ORDER: Record<CommandKind, number> = { page: 0, project: 1, tab: 2, terminal: 3, action: 4 };

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);

/** How well one typed word fits a command: 0 when it doesn't. */
function wordScore(w: string, label: string, labelWords: string[], extraWords: string[]): number {
  if (label.startsWith(w)) return 4;
  if (labelWords.some((x) => x.startsWith(w))) return 3;
  if (extraWords.some((x) => x.startsWith(w))) return 2;
  if (label.includes(w) || extraWords.some((x) => x.includes(w))) return 1;
  return 0;
}

/**
 * The commands that match `query`, best first: every word typed has to match (the label or the keywords, from a
 * word's start best), so "acc ver" finds "acccess › Vercel". An empty query keeps them all, in the order given.
 */
export function rankCommands<T extends Command>(items: readonly T[], query: string, limit = 50): T[] {
  const typed = words(query);
  if (!typed.length) return items.slice(0, limit);
  const q = query.trim().toLowerCase();
  const scored: { item: T; score: number; at: number }[] = [];
  items.forEach((item, at) => {
    const label = item.label.toLowerCase();
    const labelWords = words(item.label);
    const extraWords = words(`${item.keywords ?? ""} ${item.detail ?? ""}`);
    let score = 0;
    for (const w of typed) {
      const s = wordScore(w, label, labelWords, extraWords);
      if (!s) return;
      score += s;
    }
    if (label === q) score += 10;
    scored.push({ item, score, at });
  });
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] ||
      a.item.label.length - b.item.label.length ||
      a.at - b.at,
  );
  return scored.slice(0, limit).map((s) => s.item);
}

/** Whether a key press is the palette's shortcut, given where it was typed. */
export function isPaletteShortcut(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  where: { inEditor: boolean; inTerminal: boolean },
): boolean {
  if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return false;
  // a code editor's own ⌘K / Ctrl+K chords (Monaco, CodeMirror)
  if (where.inEditor) return false;
  // Ctrl+K in a shell deletes to the end of the line; ⌘K does nothing there, so it stays the palette's
  if (where.inTerminal && e.ctrlKey && !e.metaKey) return false;
  return true;
}
