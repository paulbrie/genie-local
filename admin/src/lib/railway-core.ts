// Pure (tested): Railway's API answers as the Railway tab (src/lib/railway.ts) and its collector
// (src/lib/railway-collector.ts) use them.

import type { RuntimeLine } from "@/lib/vercel-issues-core";

/** A deployment's status, as a dot: done well, failed, still under way, or gone / not running. */
export function stateOf(status: string): "ok" | "failed" | "busy" | "off" {
  if (status === "SUCCESS") return "ok";
  if (status === "FAILED" || status === "CRASHED") return "failed";
  if (["BUILDING", "DEPLOYING", "INITIALIZING", "QUEUED", "WAITING", "NEEDS_APPROVAL", "REMOVING"].includes(status)) return "busy";
  return "off";
}

/**
 * Railway's window for "up to `limit` log lines between `start` and `end`" (environmentLogs, httpLogs), as its CLI
 * asks: the lines before an anchor at `end`, back to `start`. Railway answers one line too many: keep the last
 * `limit` (lastN).
 */
export function logWindow(start: Date, end: Date, limit = 500) {
  return { beforeDate: start.toISOString(), beforeLimit: limit, anchorDate: end.toISOString(), afterDate: end.toISOString(), afterLimit: 0 };
}

export const lastN = <T>(rows: T[], n: number): T[] => (rows.length > n ? rows.slice(rows.length - n) : rows);

export type RawLog = { timestamp: string; message: string; severity?: string | null; attributes?: { key: string; value: string }[] | null };

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** A log line: when (ms), its level (its `level` attribute, else its severity, else "info") and its text. */
export function logLine(l: RawLog): { at: number | null; level: string; text: string } {
  const attr = l.attributes?.find((a) => a.key === "level" || a.key === "severity")?.value;
  const at = Date.parse(l.timestamp);
  return { at: Number.isNaN(at) ? null : at, level: (attr ?? l.severity ?? "info").toLowerCase().replace(/^"|"$/g, ""), text: l.message.replace(ANSI, "") };
}

/** What a deployment's `meta` says of where it came from. */
export function deploymentMeta(meta: unknown): { branch: string | null; commit: string | null; message: string | null; repo: string | null } {
  const m = (meta && typeof meta === "object" ? meta : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof m[k] === "string" && (m[k] as string).trim() ? (m[k] as string) : null);
  return {
    branch: s("branch"),
    commit: s("commitHash")?.slice(0, 7) ?? null,
    message: s("commitMessage")?.split("\n")[0] ?? null,
    repo: s("repo"),
  };
}

/** "owner/repo", lowercased, from a GitHub URL or Railway's own "owner/repo": to match a service to this project's git origin. */
export function repoKey(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/(?:github\.com[:/])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** An error or warning log line of a service, as a production problem's line (vercel-issues-core's problemOf). */
export function deployRuntimeLine(l: { at: number | null; level: string; text: string }): RuntimeLine {
  return { at: l.at, level: l.level === "warn" ? "warning" : l.level, source: null, text: l.text, method: null, path: null, status: null };
}

export type RawHttpLog = { timestamp: string; method: string; path: string; httpStatus: number; totalDuration?: number; upstreamErrors?: string | null };

/** A request Railway answered, as a production problem's line: a 5xx is one, with what its upstream said if anything. */
export function httpRuntimeLine(h: RawHttpLog): RuntimeLine {
  const at = Date.parse(h.timestamp);
  const why = h.upstreamErrors && h.upstreamErrors !== "[]" ? h.upstreamErrors : "";
  return { at: Number.isNaN(at) ? null : at, level: "info", source: null, text: why, method: h.method, path: h.path, status: h.httpStatus };
}

/** Where a deployment shows on Railway's own site. */
export const deploymentUrl = (projectId: string, serviceId: string | null, environmentId: string, deploymentId: string) =>
  serviceId
    ? `https://railway.com/project/${projectId}/service/${serviceId}?environmentId=${environmentId}&id=${deploymentId}`
    : `https://railway.com/project/${projectId}?environmentId=${environmentId}`;
