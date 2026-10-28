import "server-only";

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { getProjectDetail } from "@/lib/scan";

import { withDefaults, type Finding, type ReviewSettings } from "./core.mjs";

export type { Finding, ReviewSettings } from "./core.mjs";

const pexec = promisify(execFile);

/**
 * Review before push. A project's settings say which pushed branches Claude
 * reviews, whose pushes (agents', people's), and from which severity a finding
 * stops the push. They're written to REVIEW_DIR/config.json, keyed by repo, and a
 * pre-push hook in each of the project's git repos runs scripts/review-hook.mjs,
 * which reads them, reviews, and writes each result to REVIEW_DIR/results. All of
 * it works without the admin running; the admin only edits the settings, installs
 * the hooks and shows the results.
 */
const DIR = process.env.REVIEW_DIR ?? "/opt/project/.review";
const CONFIG = path.join(DIR, "config.json");
const RESULTS = path.join(DIR, "results");
const HOOK_SCRIPT = path.join(process.cwd(), "scripts", "review-hook.mjs");
/** Marks the hook as ours, so it's never mistaken for (or written over) a project's own. */
const MARK = "# genie-review";
const CHAINED = "pre-push.genie-chained";

type Config = { repos: Record<string, { project: string; settings: ReviewSettings }> };

export type HookState =
  | { repo: string; state: "installed"; chained: boolean }
  | { repo: string; state: "missing" }
  | { repo: string; state: "manual"; why: string; line: string };

export type ReviewResult = {
  id: string;
  at: string;
  project: string;
  repo: string;
  branch: string;
  head: string;
  base: string | null;
  commits: string[];
  pusher: "agent" | "person";
  verdict: "passed" | "warned" | "blocked" | "error" | "timeout" | "overridden";
  summary: string;
  findings: Finding[];
  note: string | null;
  cached: boolean;
  durationMs: number;
  costUsd: number | null;
};

export type ProjectReview = { settings: ReviewSettings; hooks: HookState[]; results: ReviewResult[] };

async function readConfig(): Promise<Config> {
  try {
    const c = JSON.parse(await fs.readFile(CONFIG, "utf8"));
    return { repos: c?.repos ?? {} };
  } catch {
    return { repos: {} };
  }
}

async function writeConfig(c: Config) {
  await fs.mkdir(DIR, { recursive: true });
  const tmp = `${CONFIG}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(c, null, 1));
  await fs.rename(tmp, CONFIG);
}

/** The project's git repos: its apps that are one. */
async function projectRepos(slug: string): Promise<string[] | null> {
  const detail = await getProjectDetail(slug);
  if (!detail) return null;
  return detail.apps.filter(({ app }) => app.isGit).map(({ app }) => app.path);
}

const git = async (repo: string, args: string[]) => (await pexec("git", ["-C", repo, ...args], { timeout: 15_000 })).stdout.trim();

/** The hook that runs the review: the repo's own pre-push hook (kept as pre-push.genie-chained) first, then ours. */
function hookText() {
  return `#!/bin/sh
${MARK}: installed by the admin (a project's Git tab, "Review before push"); turned off there, it goes.
input=$(cat)
here=$(dirname "$0")
if [ -x "$here/${CHAINED}" ]; then
  printf '%s\\n' "$input" | "$here/${CHAINED}" "$@" || exit $?
fi
printf '%s\\n' "$input" | "${process.execPath}" "${HOOK_SCRIPT}" "$(pwd)" "$@"
`;
}

/** Where a repo's hooks live, and whether another tool (husky…) generates them there. */
async function hooksDir(repo: string) {
  const custom = await git(repo, ["config", "--get", "core.hooksPath"]).catch(() => "");
  const dir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
  return { dir, custom };
}

export async function hookState(repo: string): Promise<HookState> {
  const { dir, custom } = await hooksDir(repo);
  const text = await fs.readFile(path.join(dir, "pre-push"), "utf8").catch(() => "");
  if (text.includes(MARK)) return { repo, state: "installed", chained: await fs.access(path.join(dir, CHAINED)).then(() => true, () => false) };
  if (custom)
    return {
      repo,
      state: "manual",
      why: `its hooks come from ${custom} (husky or the like), which would write over ours: add this line to the repo's own pre-push hook`,
      line: `"${process.execPath}" "${HOOK_SCRIPT}" "$(pwd)" "$@"`,
    };
  return { repo, state: "missing" };
}

export async function install(repo: string) {
  const { dir, custom } = await hooksDir(repo);
  if (custom) return; // see hookState: the user adds the line
  await fs.mkdir(dir, { recursive: true });
  const hook = path.join(dir, "pre-push");
  const existing = await fs.readFile(hook, "utf8").catch(() => null);
  if (existing?.includes(MARK)) return;
  // a project's own pre-push hook keeps running, before the review
  if (existing !== null) await fs.rename(hook, path.join(dir, CHAINED));
  await fs.writeFile(hook, hookText(), { mode: 0o755 });
}

export async function uninstall(repo: string) {
  const { dir } = await hooksDir(repo);
  const hook = path.join(dir, "pre-push");
  const existing = await fs.readFile(hook, "utf8").catch(() => null);
  if (!existing?.includes(MARK)) return;
  await fs.rm(hook);
  await fs.rename(path.join(dir, CHAINED), hook).catch(() => {});
}

/** The newest results for a project, newest first. */
async function results(project: string, limit = 30): Promise<ReviewResult[]> {
  const names = (await fs.readdir(RESULTS).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort().reverse();
  const out: ReviewResult[] = [];
  for (const n of names) {
    if (out.length >= limit) break;
    const r = JSON.parse(await fs.readFile(path.join(RESULTS, n), "utf8").catch(() => "null")) as ReviewResult | null;
    if (r?.project === project) out.push(r);
  }
  return out;
}

export async function projectReview(slug: string): Promise<ProjectReview | null> {
  const repos = await projectRepos(slug);
  if (!repos) return null;
  const config = await readConfig();
  const settings = withDefaults(repos.map((r) => config.repos[r]?.settings).find(Boolean));
  return { settings, hooks: await Promise.all(repos.map(hookState)), results: await results(slug) };
}

/** Saves a project's settings for all its repos and installs (or, turned off, removes) their hooks. */
export async function saveProjectReview(slug: string, settings: ReviewSettings): Promise<ProjectReview | null> {
  const repos = await projectRepos(slug);
  if (!repos) return null;
  const config = await readConfig();
  for (const repo of repos) config.repos[repo] = { project: slug, settings };
  await writeConfig(config);
  for (const repo of repos) await (settings.enabled ? install(repo) : uninstall(repo));
  return projectReview(slug);
}
