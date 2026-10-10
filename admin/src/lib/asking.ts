/**
 * Whether an assistant message ends by asking the user something, so a session
 * that stopped there is waiting on them even without AskUserQuestion. The rule
 * is deliberately conservative: a "?" in the message's last paragraph, after
 * leaving out what can hold a "?" without asking anything:
 * - code: fenced blocks (``` or ~~~, also one left open) and `inline` code;
 * - quotes: "…" / “…” strings and > quoted lines;
 * - links: URLs (query strings).
 * A question earlier in the message, followed by another paragraph ("Done. …
 * Shall I push?\n\nTests pass."), doesn't count: the turn ended on something else.
 */
export function asksUser(text: string): boolean {
  const t = text
    .replace(/(```|~~~)[\s\S]*?\1/g, "\n\n")
    .replace(/(```|~~~)[\s\S]*$/, "");
  const paras = t
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const last = paras[paras.length - 1];
  if (!last) return false;
  const s = last
    .split("\n")
    .filter((l) => !/^\s*>/.test(l))
    .join(" ")
    .replace(/`[^`\n]*`/g, "")
    .replace(/\bhttps?:\/\/\S+/g, "")
    .replace(/"[^"\n]*"|“[^”\n]*”/g, "");
  return /[?？]/.test(s);
}
