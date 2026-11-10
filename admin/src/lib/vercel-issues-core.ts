// Which of Vercel's runtime log lines are production problems, and which are "the same problem" (one issue,
// counted). Pure: vercel-issues-core.test.ts runs it directly.

import { createHash } from "node:crypto";

/** A runtime log line as src/lib/vercel.ts normalizes it. */
export type RuntimeLine = {
  at: number | null;
  level: string;
  source: string | null;
  text: string;
  method: string | null;
  path: string | null;
  status: number | null;
};

export type Problem = {
  level: "error" | "warning";
  title: string;
  fingerprint: string;
  message: string;
  path: string | null;
  method: string | null;
  status: number | null;
};

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

/** /users/123/orders/9f8e7d6c-…?x=1 → /users/:id/orders/:id: the page, not the visit. */
export function normPath(p: string | null): string | null {
  if (!p) return null;
  const path = p.split("?")[0].split("#")[0];
  return (
    path
      .split("/")
      .map((seg) =>
        /^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^[0-9a-f]{12,}$/i.test(seg) || /^[A-Za-z0-9_-]{24,}$/.test(seg)
          ? ":id"
          : seg,
      )
      .join("/") || "/"
  );
}

/** A message with what changes between occurrences taken out (ids, numbers, quoted values, URLs, times). */
export function normMessage(s: string): string {
  return s
    .toLowerCase()
    .replace(/"[^"]{0,200}"|'[^']{0,200}'|`[^`]{0,200}`/g, "<str>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<hex>")
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 20);

/** The problem a log line is, or null when it's none (an info line, a 2xx/3xx/4xx request). */
export function problemOf(l: RuntimeLine): Problem | null {
  const lvl = l.level.toLowerCase();
  const failed = l.status != null && l.status >= 500;
  const level = lvl === "error" || lvl === "fatal" || failed ? "error" : lvl === "warning" || lvl === "warn" ? "warning" : null;
  if (!level) return null;
  const message = stripAnsi(l.text).trim().slice(0, 4000);
  const path = normPath(l.path);
  const first = message.split("\n").find((x) => x.trim())?.trim() ?? "";
  // (a failed request with nothing printed: the request is the problem)
  const title = (first || `HTTP ${l.status} on ${l.method ?? "GET"} ${path ?? "/"}`).slice(0, 200);
  const key = first ? `${level}|${normMessage(first)}` : `${level}|http ${l.status}|${l.method ?? ""} ${path ?? ""}`;
  return { level, title, fingerprint: sha(key), message, path, method: l.method, status: l.status != null && l.status > 0 ? l.status : null };
}

/** A failed production build: one issue each (its deployment is what's wrong). */
export function buildProblemFingerprint(deploymentId: string): string {
  return sha(`build|${deploymentId}`);
}
