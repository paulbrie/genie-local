import * as React from "react";

import { BASE_PATH } from "@/lib/config";
import { cn } from "@/lib/utils";

/**
 * A dependency-free Markdown renderer for the small subset our docs use:
 * headings, paragraphs, bold/italic/strikethrough, inline + fenced code,
 * links (and bare URLs), ordered / unordered / task lists, blockquotes, GFM
 * pipe tables, and `---` rules. It builds React elements directly (no
 * `dangerouslySetInnerHTML`), so rendered content can't inject markup, and
 * links only go to http(s), mailto, or a path / anchor (no `javascript:`).
 *
 * This intentionally mirrors the repo's hand-rolled frontmatter parser rather
 * than pulling in remark/marked for one README.
 */

/* --------------------------------- inline --------------------------------- */

/** A link target that's safe to render: http(s), mailto, or a path / anchor on this site. */
function safeHref(href: string): string | null {
  if (/^(https?:\/\/|mailto:)/i.test(href)) return href;
  // a site path is the admin's own: under its base path
  if (/^\/(?!\/)/.test(href)) return BASE_PATH && !href.startsWith(`${BASE_PATH}/`) ? `${BASE_PATH}${href}` : href;
  if (/^(#|\.{1,2}\/)/.test(href)) return href;
  return null;
}

function renderLink(href: string, label: React.ReactNode, key: string): React.ReactNode {
  const safe = safeHref(href);
  if (!safe) return <span key={key}>{label}</span>;
  const external = /^https?:\/\//i.test(safe);
  return (
    <a
      key={key}
      href={safe}
      className="font-medium text-primary underline underline-offset-2 break-words hover:no-underline"
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
    >
      {label}
    </a>
  );
}

type InlineRule = {
  re: RegExp;
  render: (m: RegExpExecArray, key: string) => React.ReactNode;
};

// Order matters: code first (opaque to other syntax), then links, then the
// greedier ** before the single-char *.
const INLINE_RULES: InlineRule[] = [
  {
    re: /`([^`]+)`/,
    render: (m, key) => (
      <code
        key={key}
        className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
      >
        {m[1]}
      </code>
    ),
  },
  {
    // the target may hold one level of parentheses: (https://en.wikipedia.org/wiki/X_(y))
    re: /\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/,
    render: (m, key) => renderLink(m[2], renderInline(m[1], `${key}i`), key),
  },
  {
    // a bare URL (trailing punctuation left out)
    re: /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/,
    render: (m, key) => renderLink(m[0], m[0], key),
  },
  {
    re: /\*\*([^*]+?)\*\*/,
    render: (m, key) => (
      <strong key={key} className="font-semibold text-foreground">
        {renderInline(m[1], `${key}i`)}
      </strong>
    ),
  },
  {
    re: /~~([^~]+?)~~/,
    render: (m, key) => <del key={key}>{renderInline(m[1], `${key}i`)}</del>,
  },
  {
    // _x_ only at word edges: snake_case_names stay as they are
    re: /(?:\*([^*\s][^*]*?)\*|(?<![\w])_([^_]+?)_(?![\w]))/,
    render: (m, key) => <em key={key}>{renderInline(m[1] ?? m[2], `${key}i`)}</em>,
  },
];

/** Turn a run of inline markdown into React nodes. */
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let rest = text;
  let n = 0;

  while (rest.length > 0) {
    let best: { idx: number; matchLen: number; node: React.ReactNode } | null =
      null;
    for (const rule of INLINE_RULES) {
      const m = rule.re.exec(rest);
      if (m && (best === null || m.index < best.idx)) {
        best = {
          idx: m.index,
          matchLen: m[0].length,
          node: rule.render(m, `${keyBase}-${n}`),
        };
      }
    }
    if (!best) {
      nodes.push(rest);
      break;
    }
    if (best.idx > 0) nodes.push(rest.slice(0, best.idx));
    nodes.push(best.node);
    rest = rest.slice(best.idx + best.matchLen);
    n++;
  }
  return nodes;
}

/* --------------------------------- blocks --------------------------------- */

const HEADING_CLASS: Record<number, string> = {
  1: "mt-2 mb-3 text-xl font-semibold tracking-tight",
  2: "mt-6 mb-2 border-b pb-1 text-lg font-semibold tracking-tight",
  3: "mt-4 mb-1.5 text-base font-semibold",
  4: "mt-3 mb-1 text-sm font-semibold",
  5: "mt-3 mb-1 text-sm font-semibold",
  6: "mt-3 mb-1 text-sm font-semibold",
};

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

/** A paragraph's lines: joined with spaces, or (breaks) kept as line breaks. */
function renderLines(lines: string[], key: string, breaks: boolean): React.ReactNode[] {
  if (!breaks) return renderInline(lines.join(" "), key);
  return lines.flatMap((l, n) => [...(n ? [<br key={`${key}br${n}`} />] : []), ...renderInline(l, `${key}l${n}`)]);
}

/** A list item's text, with a GFM task box ("[ ]" / "[x]") drawn as one. */
function renderItem(text: string, key: string): React.ReactNode {
  const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
  if (!task) return renderInline(text, key);
  const done = task[1] !== " ";
  return (
    <span className="inline-flex items-start gap-1.5">
      <input type="checkbox" checked={done} readOnly disabled className="mt-1 size-3.5 shrink-0 accent-primary" />
      <span className={done ? "text-muted-foreground line-through" : ""}>{renderInline(task[2], key)}</span>
    </span>
  );
}

const LIST_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
const QUOTE_RE = /^\s*>\s?/;

function renderBlocks(md: string, breaks = false): React.ReactNode[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  const nextKey = () => `b${key++}`;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line — skip.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block.
    const fence = /^\s*```([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      out.push(
        <pre
          key={nextKey()}
          className="my-3 overflow-x-auto rounded-md border bg-muted/60 p-3 text-xs leading-relaxed"
        >
          <code className="font-mono">{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(<hr key={nextKey()} className="my-5 border-border" />);
      i++;
      continue;
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      // Not `keyof JSX.IntrinsicElements`: @react-three/fiber adds three.js
      // elements to that set, and their children types don't take text.
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      out.push(
        <Tag key={nextKey()} className={HEADING_CLASS[level]}>
          {renderInline(heading[2].trim(), nextKey())}
        </Tag>,
      );
      i++;
      continue;
    }

    // GFM table: a header row followed by a separator row.
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const header = splitTableRow(line);
      i += 2; // header + separator
      const body: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        body.push(splitTableRow(lines[i]));
        i++;
      }
      out.push(
        <div key={nextKey()} className="my-3 overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                {header.map((cell, c) => (
                  <th
                    key={c}
                    className="border-b px-3 py-1.5 text-left font-medium"
                  >
                    {renderInline(cell, `${nextKey()}-${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                <tr key={r} className="border-b last:border-0">
                  {row.map((cell, c) => (
                    <td key={c} className="px-3 py-1.5 align-top">
                      {renderInline(cell, `${nextKey()}-${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Blockquote: its lines, rendered as markdown in turn.
    if (QUOTE_RE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) buf.push(lines[i++].replace(QUOTE_RE, ""));
      out.push(
        <blockquote key={nextKey()} className="my-2 border-l-2 pl-3 text-muted-foreground">
          {renderBlocks(buf.join("\n"), breaks)}
        </blockquote>,
      );
      continue;
    }

    // Unordered or ordered list (by its first item). Continuation lines
    // (indented, non-blank) fold into the current item so wrapped list
    // entries render as one bullet.
    if (LIST_RE.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const start = ordered ? parseInt(line.trim(), 10) : undefined;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(.*)$/.exec(l);
        if (m) {
          items.push(m[1]);
          i++;
        } else if (l.trim() && /^\s+/.test(l) && items.length) {
          items[items.length - 1] += ` ${l.trim()}`;
          i++;
        } else {
          break;
        }
      }
      const List = ordered ? "ol" : "ul";
      out.push(
        <List
          key={nextKey()}
          start={start !== 1 ? start : undefined}
          className={`my-2 space-y-1 pl-5 text-sm leading-relaxed ${ordered ? "list-decimal" : "list-disc"}`}
        >
          {items.map((it, idx) => (
            // a task item's box stands in for its bullet
            <li key={idx} className={/^\[[ xX]\]\s/.test(it) ? "-ml-5 list-none" : undefined}>
              {renderItem(it, `${nextKey()}-${idx}`)}
            </li>
          ))}
        </List>,
      );
      continue;
    }

    // Paragraph: gather consecutive plain lines until a blank line or a line
    // that starts another block.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      const l = lines[i];
      if (
        /^\s*```/.test(l) ||
        /^(#{1,6})\s+/.test(l) ||
        /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l) ||
        LIST_RE.test(l) ||
        QUOTE_RE.test(l) ||
        (l.includes("|") &&
          i + 1 < lines.length &&
          isTableSeparator(lines[i + 1]))
      ) {
        break;
      }
      para.push(breaks ? l.trimEnd() : l.trim());
      i++;
    }
    if (para.length) {
      out.push(
        <p key={nextKey()} className="my-2 text-sm leading-relaxed">
          {renderLines(para, nextKey(), breaks)}
        </p>,
      );
    }
  }

  return out;
}

export function Markdown({
  source,
  className,
  breaks = false,
}: {
  source: string;
  className?: string;
  /** keep single line breaks (notes, tickets, comments), as GitHub comments do */
  breaks?: boolean;
}) {
  return (
    <div className={cn("text-foreground/90", className)}>
      {renderBlocks(source, breaks)}
    </div>
  );
}
