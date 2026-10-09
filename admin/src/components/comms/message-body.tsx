"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { TAG_NAMES, type TagName } from "@/lib/claude-comms-parse";
import { TAG_COLORS } from "@/lib/comms-colors";

/**
 * Light, safe rendering of a (redacted) message body: built from React
 * elements only, never raw HTML. Handles fenced and inline code, JSX and
 * `{expressions}` as code, identifiers and `calls()` as code, file paths as
 * chips, known commit hashes as links, URLs, bullet and numbered lists
 * (including inline "(1) … (2) …" enumerations), and protocol tags at the
 * start of a line as coloured badges.
 */

export type CommitLink = { abbrev: string; hash: string; href: string | null; subject: string | null };

type Ctx = { commits: CommitLink[] };

// ── Inline ───────────────────────────────────────────────────────────────────

const EXT =
  "tsx?|jsx?|mjs|cjs|json|md|mdx|css|scss|sql|py|sh|ya?ml|toml|go|rs|html|prisma|env|lock|txt|log|svg|png";
// Order matters: earlier alternatives win at the same position.
const INLINE = new RegExp(
  [
    "(?<code>`[^`\\n]+`)",
    "(?<bold>\\*\\*[^*\\n]+\\*\\*)",
    "(?<url>https?:\\/\\/[^\\s<>()\"'`]+[^\\s<>()\"'`.,;:!?])",
    // <Comp prop={x} />, </div>, <aside aria-label="…">
    "(?<jsx></?[A-Za-z][\\w.]*(?:\\s+[^<>\\n]{0,160}?)?\\s*/?>)",
    // {selCar !== null && <CarPanel car={selCar} />}: one level of nesting
    "(?<expr>\\{(?:[^{}\\n]|\\{[^{}\\n]*\\}){2,160}\\})",
    `(?<path>(?:~|\\.{1,2})?(?:\\/?[\\w@.-]+\\/)*[\\w@-][\\w@.-]*\\.(?:${EXT})(?::\\d+)?(?![\\w/]))`,
    // zoomTo(piece), fit(), lane.settle()
    "(?<call>\\b[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\([^()\\n]{0,40}\\))",
    "(?<hash>\\b[0-9a-f]{7,40}\\b)",
    // camelCase, PascalCase with two humps, snake_case, SCREAMING_CASE identifiers
    "(?<ident>\\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[a-z0-9]+_[a-z0-9_]+|[A-Z][A-Z0-9]*_[A-Z0-9_]+)\\b)",
  ].join("|"),
  "g",
);

// Two-hump words that are just words.
const NOT_IDENT = new Set(["JavaScript", "TypeScript", "GitHub", "PostgreSQL", "YouTube", "iPhone", "macOS", "LinkedIn", "OpenAI", "WebSocket", "WebSockets", "McDonald"]);

const codeCls = "rounded bg-muted px-1 py-px font-mono text-[0.85em]";

function inline(text: string, ctx: Ctx, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const g = m.groups!;
    const start = m.index!;
    const raw = m[0];
    let node: ReactNode | null = null;
    const key = `${keyBase}-${i++}`;
    if (g.code) node = <code key={key} className={codeCls}>{raw.slice(1, -1)}</code>;
    else if (g.bold) node = <strong key={key}>{inline(raw.slice(2, -2), ctx, key)}</strong>;
    else if (g.url)
      node = (
        <a key={key} href={raw} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 break-all">
          {raw}
        </a>
      );
    else if (g.jsx || g.expr || g.call) node = <code key={key} className={codeCls}>{raw}</code>;
    else if (g.path)
      node = (
        <span key={key} title={raw} className="rounded border bg-muted/60 px-1 py-px font-mono text-[0.85em] break-all">
          {raw}
        </span>
      );
    else if (g.hash) {
      const c = ctx.commits.find((x) => x.hash.startsWith(raw) || raw.startsWith(x.hash));
      if (c)
        node = c.href ? (
          <Link key={key} href={c.href} title={c.subject ?? undefined} className="font-mono text-primary hover:underline">
            {raw}
          </Link>
        ) : (
          <code key={key} className={codeCls} title={c.subject ?? undefined}>{raw}</code>
        );
    } else if (g.ident && !NOT_IDENT.has(raw)) node = <code key={key} className={codeCls}>{raw}</code>;

    if (node === null) continue; // leave unrecognised matches as text
    if (start > last) out.push(text.slice(last, start));
    out.push(node);
    last = start + raw.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ── Blocks ───────────────────────────────────────────────────────────────────

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[]; start: number }
  | { kind: "code"; text: string }
  | { kind: "tag"; tag: TagName; rest: string };

const TAG_LINE = new RegExp(`^\\s*(${TAG_NAMES.join("|")}):\\s*(.*)$`);
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;

function toBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", lines: para });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const tag = line.match(TAG_LINE);
    const bullet = line.match(BULLET);
    const num = line.match(NUMBERED);
    if (tag) {
      flush();
      blocks.push({ kind: "tag", tag: tag[1] as TagName, rest: tag[2] });
    } else if (bullet) {
      flush();
      const prev = blocks[blocks.length - 1];
      if (prev?.kind === "ul") prev.items.push(bullet[1]);
      else blocks.push({ kind: "ul", items: [bullet[1]] });
    } else if (num) {
      flush();
      const prev = blocks[blocks.length - 1];
      if (prev?.kind === "ol") prev.items.push(num[2]);
      else blocks.push({ kind: "ol", items: [num[2]], start: Number(num[1]) });
    } else if (!line.trim()) {
      flush();
    } else if (/^\s{2,}\S/.test(line) && !para.length && blocks.length) {
      // Indented continuation of the previous list item.
      const prev = blocks[blocks.length - 1];
      if (prev.kind === "ul" || prev.kind === "ol") prev.items[prev.items.length - 1] += ` ${line.trim()}`;
      else para.push(line);
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks.flatMap(splitEnumerations);
}

/** "Lead: (1) foo; (2) bar." → a paragraph plus a numbered list. Numbers must run 1, 2, 3… */
function splitEnumerations(b: Block): Block[] {
  if (b.kind !== "p") return [b];
  const text = b.lines.join("\n");
  const marks = [...text.matchAll(/(^|[\s:;,—-])\((\d{1,2})\)\s+/g)];
  const seq: RegExpMatchArray[] = [];
  for (const m of marks) if (Number(m[2]) === seq.length + 1) seq.push(m);
  if (seq.length < 2) return [b];
  const at = (m: RegExpMatchArray) => m.index! + m[1].length;
  const lead = text.slice(0, at(seq[0])).trim();
  const items = seq.map((m, i) =>
    text
      .slice(at(m) + m[0].length - m[1].length, i + 1 < seq.length ? at(seq[i + 1]) : undefined)
      .trim()
      .replace(/[;,]\s*(and|or)?\s*$/i, "")
      .trim(),
  );
  // Lines after the last item's line stay a paragraph.
  const lastItem = items[items.length - 1];
  const tailAt = lastItem.indexOf("\n");
  const tail = tailAt >= 0 ? lastItem.slice(tailAt).trim() : "";
  if (tailAt >= 0) items[items.length - 1] = lastItem.slice(0, tailAt).trim();
  const out: Block[] = [];
  if (lead) out.push({ kind: "p", lines: [lead] });
  out.push({ kind: "ol", items, start: 1 });
  if (tail) out.push({ kind: "p", lines: tail.split("\n") });
  return out;
}

export function TagBadge({ tag }: { tag: TagName }) {
  const color = TAG_COLORS[tag];
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center rounded px-1.5 font-mono text-[11px] font-semibold"
      style={{ background: `${color}26`, color, boxShadow: `inset 0 0 0 1px ${color}66` }}
    >
      {tag}
    </span>
  );
}

export function MessageBody({ body, commits }: { body: string; commits: CommitLink[] }) {
  const ctx: Ctx = { commits };
  return (
    <div className="space-y-2.5 text-sm leading-relaxed break-words">
      {toBlocks(body).map((b, i) => {
        const k = `b${i}`;
        switch (b.kind) {
          case "code":
            return (
              <pre key={k} className="overflow-x-auto rounded-md border bg-muted/40 p-2 font-mono text-xs">
                {b.text}
              </pre>
            );
          case "tag":
            return (
              <div key={k} className="flex items-start gap-2">
                <TagBadge tag={b.tag} />
                <span className="min-w-0">{inline(b.rest, ctx, k)}</span>
              </div>
            );
          case "ul":
            return (
              <ul key={k} className="list-disc space-y-1 pl-5 marker:text-muted-foreground">
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, ctx, `${k}-${j}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={k} start={b.start} className="list-decimal space-y-1 pl-5 marker:text-muted-foreground">
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, ctx, `${k}-${j}`)}</li>
                ))}
              </ol>
            );
          case "p":
            return (
              <p key={k}>
                {b.lines.map((l, j) => (
                  <span key={j}>
                    {j > 0 && <br />}
                    {inline(l, ctx, `${k}-${j}`)}
                  </span>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
