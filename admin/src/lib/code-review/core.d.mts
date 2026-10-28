// Types for core.mjs (kept as plain JS so the git hook can import it).

export type Severity = "high" | "medium" | "low";

export type ReviewSettings = {
  enabled: boolean;
  branches: string[];
  blockAt: Severity | "never";
  who: "both" | "agents" | "people";
  effort: "low" | "medium" | "high";
  skip: string[];
  timeoutSec: number;
};

export type Finding = { severity: Severity; file: string; line?: number; title: string; detail: string };

export type PushLine = { localRef: string; localSha: string; remoteRef: string; branch: string; remoteSha: string | null };

export const SEVERITIES: Severity[];
export const DEFAULT_SETTINGS: ReviewSettings;
export const FINDINGS_SCHEMA: object;
export function withDefaults(s: Partial<ReviewSettings> | null | undefined): ReviewSettings;
export function globToRegExp(glob: string): RegExp;
export function branchSelected(branch: string, patterns: string[]): boolean;
export function pusherSelected(who: ReviewSettings["who"], isAgent: boolean): boolean;
export function parsePushLines(stdin: string): PushLine[];
export function verdictFor(findings: Finding[], blockAt: ReviewSettings["blockAt"]): "blocked" | "warned" | "passed";
export function reviewPrompt(o: { project: string; branch: string; commits: string[]; truncated: boolean }): string;
