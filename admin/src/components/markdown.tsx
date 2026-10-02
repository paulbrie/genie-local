import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A dependency-free Markdown renderer for the small subset our docs use:
 * headings, paragraphs, bold/italic, inline + fenced code, links, unordered
 * lists, GFM pipe tables, and `---` rules. It builds React elements directly
 * (no `dangerouslySetInnerHTML`), so rendered content can't inject markup.
 *
 * This intentionally mirrors the repo's hand-rolled frontmatter parser rather
 * than pulling in remark/marked for one README.
 */

/* --------------------------------- inline --------------------------------- */

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
    re: /\[([^\]]+)\]\(([^)\s]+)\)/,
    render: (m, key) => (
      <a
        key={key}
        href={m[2]}
        className="font-medium text-primary underline underline-offset-2 hover:no-underline"
        target={/^https?:\/\//.test(m[2]) ? "_blank" : undefined}
        rel={/^https?:\/\//.test(m[2]) ? "noreferrer" : undefined}
      >
        {renderInline(m[1], `${key}i`)}
      </a>
    ),
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
    re: /(?:\*([^*]+?)\*|_([^_]+?)_)/,
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

function renderBlocks(md: string): React.ReactNode[] {
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
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
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
      const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;
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

    // Unordered list. Continuation lines (indented, non-blank) fold into the
    // current item so wrapped list entries render as one bullet.
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = /^\s*[-*]\s+(.*)$/.exec(l);
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
      out.push(
        <ul
          key={nextKey()}
          className="my-2 list-disc space-y-1 pl-5 text-sm leading-relaxed"
        >
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `${nextKey()}-${idx}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Paragraph: gather consecutive plain lines until a blank line or a line
    // that starts another block.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      const l = lines[i];
      if (
        /^```/.test(l) ||
        /^(#{1,6})\s+/.test(l) ||
        /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l) ||
        /^\s*[-*]\s+/.test(l) ||
        (l.includes("|") &&
          i + 1 < lines.length &&
          isTableSeparator(lines[i + 1]))
      ) {
        break;
      }
      para.push(l.trim());
      i++;
    }
    if (para.length) {
      out.push(
        <p key={nextKey()} className="my-2 text-sm leading-relaxed">
          {renderInline(para.join(" "), nextKey())}
        </p>,
      );
    }
  }

  return out;
}

export function Markdown({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  return (
    <div className={cn("text-foreground/90", className)}>
      {renderBlocks(source)}
    </div>
  );
}
