/**
 * Team recipes, the pure part (no IO, unit-tested): parse and validate a
 * team's `team.json` and its members' prompt files, scan them for anything
 * that looks like a credential, and build the exact `claude` and `tmux`
 * argument arrays a launch uses. Commands are always argument arrays, run
 * with execFile; recipe text never reaches a shell. IO lives in `teams.ts`.
 *
 * A recipe lives in `<TEAMS_ROOT>/<slug>/`:
 *   team.json   { name, description, rulesDoc?, lead, projects?, members: [...] }
 *   <Name>.md   each member's first prompt (the file named by `prompt`)
 */
import { redact } from "@/lib/claude-comms-parse";

/** Claude Code 2.1's `--effort` choices. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** `--permission-mode` choices recipes may use. `bypassPermissions` is refused outright. */
export const PERMISSION_MODES = ["auto", "acceptEdits", "manual", "plan", "dontAsk"] as const;
export type Effort = (typeof EFFORTS)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** How a mode is shown: what it lets the session do without asking. */
export const PERMISSION_INFO: Record<PermissionMode, { tone: "warn" | "neutral"; text: string }> = {
  auto: { tone: "warn", text: "auto: a classifier approves most actions without asking" },
  acceptEdits: { tone: "warn", text: "acceptEdits: file edits without asking" },
  manual: { tone: "neutral", text: "manual: asks before each action" },
  plan: { tone: "neutral", text: "plan: read-only planning" },
  dontAsk: { tone: "neutral", text: "dontAsk: denies anything not pre-allowed" },
};

const MODEL_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);
const MODEL_ID_RE = /^claude-[a-z0-9][a-z0-9.-]{1,60}(\[1m\])?$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** Stricter than terminals.ts (which forbids only `.`, `:` and control chars): plain names. */
const MEMBER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
const PROMPT_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,60}\.md$/;
const TOOL_RE = /^[A-Za-z0-9_*()./:, -]{1,120}$/;
/** Members' working dirs must be under one of these. */
export const CWD_ROOTS = ["/opt/project", "/tmp"];
const MAX_MEMBERS = 12;
const MAX_PROMPT = 8000;

export type TeamMember = {
  name: string;
  role: string;
  cwd: string;
  model: string;
  effort: Effort;
  permissionMode: PermissionMode;
  allowedTools: string[];
  promptFile: string;
  prompt: string;
};

export type TeamRecipe = {
  slug: string;
  name: string;
  description: string;
  rulesDoc: string | null;
  lead: string;
  /** Agents City project names (`?projects=`) the team works in. */
  projects: string[];
  /** Lead first, then the rest in file order. */
  members: TeamMember[];
};

export type ParseResult = { ok: true; recipe: TeamRecipe } | { ok: false; errors: string[] };

const TEAM_KEYS = new Set(["name", "description", "rulesDoc", "lead", "projects", "members"]);
const MEMBER_KEYS = new Set(["name", "role", "cwd", "model", "effort", "permissionMode", "allowedTools", "prompt"]);
/** Never accepted, under any key, anywhere in a recipe. */
const DANGEROUS_RE = /dangerously-skip-permissions|allow-dangerously|bypassPermissions/i;

/** Text that the Comms redactor would change contains something credential-like. */
export function looksLikeCredential(text: string): boolean {
  // Long opaque tokens: 40+ characters mixing upper, lower and digits, with no
  // slash, so file paths and commit hashes don't count.
  return (
    redact(text) !== text ||
    /(?<![\w/-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}={0,2}(?![\w/-])/.test(text)
  );
}

export function isAllowedCwd(cwd: string): boolean {
  if (!cwd.startsWith("/") || cwd.includes("\0")) return false;
  const parts = cwd.split("/");
  if (parts.includes("..") || parts.includes(".")) return false;
  return CWD_ROOTS.some((r) => cwd === r || cwd.startsWith(`${r}/`));
}

/**
 * Parse and validate a recipe. `readPrompt(file)` returns a prompt file's text
 * (null when missing); `dirExists(path)` checks a member's cwd.
 */
export function parseTeam(
  slug: string,
  json: string,
  readPrompt: (file: string) => string | null,
  dirExists: (path: string) => boolean,
): ParseResult {
  const errors: string[] = [];
  if (!SLUG_RE.test(slug)) return { ok: false, errors: [`team folder "${slug}": use lowercase letters, digits and dashes`] };
  if (DANGEROUS_RE.test(json)) errors.push("asks for bypassPermissions or a dangerous permission flag, which recipes may not use");
  if (looksLikeCredential(json)) errors.push("team.json contains something that looks like a credential; recipes must not hold any");
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, errors: [...errors, `team.json is not valid JSON: ${(e as Error).message}`] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: [...errors, "team.json must be an object"] };
  const t = raw as Record<string, unknown>;
  for (const k of Object.keys(t)) if (!TEAM_KEYS.has(k)) errors.push(`unknown key "${k}"`);

  const str = (v: unknown, field: string, max = 200): string => {
    if (typeof v !== "string" || !v.trim()) {
      errors.push(`${field} is required`);
      return "";
    }
    if (v.length > max) errors.push(`${field} is longer than ${max} characters`);
    return v.trim();
  };

  const name = str(t.name, "name", 60);
  const description = str(t.description, "description", 400);
  const lead = str(t.lead, "lead", 40);
  let rulesDoc: string | null = null;
  if (t.rulesDoc !== undefined) {
    rulesDoc = str(t.rulesDoc, "rulesDoc", 300);
    if (rulesDoc && !isAllowedCwd(rulesDoc)) errors.push(`rulesDoc must be an absolute path under ${CWD_ROOTS.join(" or ")}`);
  }
  let projects: string[] = [];
  if (t.projects !== undefined) {
    if (!Array.isArray(t.projects) || t.projects.some((p) => typeof p !== "string" || !/^[\w.-]{1,60}$/.test(p))) {
      errors.push("projects must be a list of project names");
    } else projects = t.projects as string[];
  }

  const members: TeamMember[] = [];
  if (!Array.isArray(t.members) || t.members.length === 0) errors.push("members must be a non-empty list");
  else if (t.members.length > MAX_MEMBERS) errors.push(`at most ${MAX_MEMBERS} members`);
  else {
    const seen = new Set<string>();
    t.members.forEach((m, i) => {
      const at = `members[${i}]`;
      if (!m || typeof m !== "object" || Array.isArray(m)) {
        errors.push(`${at} must be an object`);
        return;
      }
      const r = m as Record<string, unknown>;
      for (const k of Object.keys(r)) if (!MEMBER_KEYS.has(k)) errors.push(`${at}: unknown key "${k}"`);
      const mName = str(r.name, `${at}.name`, 40);
      if (mName && !MEMBER_NAME_RE.test(mName)) errors.push(`${at}.name "${mName}": letters, digits, spaces, _ and - only`);
      if (mName && seen.has(mName.toLowerCase())) errors.push(`${at}.name "${mName}" is used twice`);
      seen.add(mName.toLowerCase());
      const label = mName || at;
      const role = str(r.role, `${label}.role`, 300);
      const cwd = str(r.cwd, `${label}.cwd`, 300);
      if (cwd && !isAllowedCwd(cwd)) errors.push(`${label}.cwd must be an absolute path under ${CWD_ROOTS.join(" or ")}`);
      else if (cwd && !dirExists(cwd)) errors.push(`${label}.cwd ${cwd} does not exist`);
      const model = str(r.model, `${label}.model`, 64);
      if (model && !MODEL_ALIASES.has(model) && !MODEL_ID_RE.test(model)) errors.push(`${label}.model "${model}": use opus, sonnet, haiku, fable or a claude-* id`);
      const effort = str(r.effort, `${label}.effort`, 10);
      if (effort && !(EFFORTS as readonly string[]).includes(effort)) errors.push(`${label}.effort must be one of ${EFFORTS.join(", ")}`);
      const pm = str(r.permissionMode, `${label}.permissionMode`, 20);
      if (pm && !(PERMISSION_MODES as readonly string[]).includes(pm)) errors.push(`${label}.permissionMode must be one of ${PERMISSION_MODES.join(", ")}`);
      let allowedTools: string[] = [];
      if (r.allowedTools !== undefined) {
        if (!Array.isArray(r.allowedTools) || r.allowedTools.some((x) => typeof x !== "string" || !TOOL_RE.test(x))) {
          errors.push(`${label}.allowedTools must be a list of tool patterns like "Bash(git *)"`);
        } else allowedTools = r.allowedTools as string[];
      }
      const promptFile = str(r.prompt, `${label}.prompt`, 64);
      let prompt = "";
      if (promptFile && !PROMPT_FILE_RE.test(promptFile)) errors.push(`${label}.prompt must be a .md file in the team folder`);
      else if (promptFile) {
        const text = readPrompt(promptFile);
        if (text == null) errors.push(`${label}: prompt file ${promptFile} not found`);
        else {
          prompt = text.trim();
          if (!prompt) errors.push(`${label}: prompt file ${promptFile} is empty`);
          if (prompt.length > MAX_PROMPT) errors.push(`${label}: prompt is longer than ${MAX_PROMPT} characters`);
          // A leading "-" would be read as a claude option, not as the prompt.
          if (prompt.startsWith("-")) errors.push(`${label}: prompt must not start with "-"`);
          if (DANGEROUS_RE.test(prompt)) errors.push(`${label}: prompt mentions a dangerous permission flag`);
          if (looksLikeCredential(prompt)) errors.push(`${label}: prompt contains something that looks like a credential`);
        }
      }
      members.push({ name: mName, role, cwd, model, effort: effort as Effort, permissionMode: pm as PermissionMode, allowedTools, promptFile, prompt });
    });
    if (lead && !members.some((m) => m.name === lead)) errors.push(`lead "${lead}" is not one of the members`);
  }

  if (errors.length) return { ok: false, errors };
  const ordered = [...members.filter((m) => m.name === lead), ...members.filter((m) => m.name !== lead)];
  return { ok: true, recipe: { slug, name, description, rulesDoc, lead, projects, members: ordered } };
}

/** The `claude` arguments for a member (after the `claude` program name). */
export function buildClaudeArgs(m: TeamMember): string[] {
  const args = ["--model", m.model, "--effort", m.effort, "--permission-mode", m.permissionMode];
  // `--allowedTools` takes several values; `-n` after it ends the list.
  if (m.allowedTools.length) args.push("--allowedTools", ...m.allowedTools);
  args.push("-n", m.name, m.prompt);
  return args;
}

/** tmux `new-session` arguments: claude runs directly in the pane (no shell), which stays readable after exit. */
export function buildNewSessionArgs(target: string, m: TeamMember): string[] {
  return [
    "new-session", "-d", "-s", target, "-x", "200", "-y", "50", "-c", m.cwd,
    "claude", ...buildClaudeArgs(m),
    ";", "set-option", "-w", "-t", target, "remain-on-exit", "on",
    ";", "set-option", "-t", target, "mouse", "on",
  ];
}

/** tmux `respawn-pane` arguments to restart an exited member in its session. */
export function buildRespawnArgs(target: string, m: TeamMember): string[] {
  return ["respawn-pane", "-k", "-t", target, "-c", m.cwd, "claude", ...buildClaudeArgs(m)];
}

export type LaunchStep = { member: TeamMember; skip: boolean; reason: string | null };

/** What Start would do, in order (lead first): who launches, who's skipped as already running. */
export function launchPlan(recipe: TeamRecipe, running: Set<string>): { steps: LaunchStep[]; opus: number; launching: number } {
  const steps = recipe.members.map((m) => ({
    member: m,
    skip: running.has(m.name),
    reason: running.has(m.name) ? "already running" : null,
  }));
  const go = steps.filter((s) => !s.skip);
  return { steps, launching: go.length, opus: go.filter((s) => /opus/i.test(s.member.model)).length };
}

/** The message Stop types into each member's Claude input. */
export const STOP_MESSAGE =
  "STATUS request from the user (the team is being stopped): commit your work, or write a STATUS: of what's left and what isn't committed, then reply. Don't start anything new.";
