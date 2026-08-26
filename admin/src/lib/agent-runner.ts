import "server-only";

import { spawn } from "node:child_process";
import { closeSync, openSync, promises as fs } from "node:fs";
import path from "node:path";

import type {
  RunConfig,
  RunLifecycle,
  RunProgress,
  RunStep,
  RunSummary,
} from "@/lib/agent-run-types";
import { AGENTS_ROOT, type Agent, type Pipeline } from "@/lib/agents";
import { runSlug } from "@/lib/run-slug";
import { AGENT_RUNS_PREFIX, AGENT_RUNS_ROOT } from "@/lib/run-paths";
import type { RunStatus } from "@/lib/runner";

/**
 * Default tool allowlist for an agent whose frontmatter omits `tools`. We
 * deliberately fall back to a READ-ONLY set (not "all tools") so a run started
 * from the dashboard can't accidentally write to / shell on the server. An
 * agent that needs more must opt in explicitly via its `tools:` frontmatter.
 */
export const READ_ONLY_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
] as const;

/** Absolute path to the detached orchestrator (override with AGENT_RUN_SCRIPT). */
const ORCHESTRATOR =
  process.env.AGENT_RUN_SCRIPT ??
  path.resolve(process.cwd(), "scripts/agent-run.mjs");

/** The `claude` CLI (on PATH by default; override with CLAUDE_BIN). */
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

const intEnv = (key: string, fallback: number): number => {
  const n = parseInt(process.env[key] ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** Max runs allowed to execute a step at once; extra runs wait in "queued". */
const MAX_CONCURRENT = intEnv("AGENT_MAX_CONCURRENT", 3);
/** Default wall-clock timeout per step (seconds) when nothing else sets one. */
const DEFAULT_TIMEOUT_SEC = intEnv("AGENT_DEFAULT_TIMEOUT_SEC", 1800);
/** Runs finished longer ago than this are pruned from history on read. */
const RETENTION_DAYS = intEnv("AGENT_RUNS_RETENTION_DAYS", 30);
/** Directory of lockfiles implementing the run-concurrency semaphore. */
const SLOTS_DIR = path.join(AGENT_RUNS_ROOT, ".slots");
/** Optional webhook the orchestrator POSTs a summary to on completion. */
const NOTIFY_WEBHOOK = process.env.AGENT_RUN_NOTIFY_WEBHOOK || null;

/** Monotonic within a process so two runs in the same ms can't collide. */
let runCounter = 0;

/**
 * A fresh, filesystem-safe id for one launch. Every Run gets its own — so the
 * same agent can run many times without clobbering each other's log/progress,
 * which is what makes a run *history* possible. Shape: `<kind>-<slug>-<token>`.
 */
function newRunId(kind: "agent" | "pipeline", slug: string): string {
  // Date + a per-process counter guarantees uniqueness even for two launches in
  // the same millisecond (the random suffix just avoids cross-process clashes).
  const token =
    Date.now().toString(36) +
    (runCounter++).toString(36).padStart(2, "0") +
    Math.floor(Math.random() * 36).toString(36);
  return runSlug(kind, slug, token);
}

// All per-run sidecar files share the runId stem under AGENT_RUNS_ROOT (a
// persistent dir, so history survives reboots). The `.log` is exposed to the
// Logs page under the AGENT_RUNS_PREFIX namespace; `.progress.json` is the
// console/history data source.
const logPathFor = (runId: string) => path.join(AGENT_RUNS_ROOT, `${runId}.log`);
const pidPathFor = (runId: string) => path.join(AGENT_RUNS_ROOT, `${runId}.pid`);
const specPathFor = (runId: string) =>
  path.join(AGENT_RUNS_ROOT, `${runId}.spec.json`);
const progressPathFor = (runId: string) =>
  path.join(AGENT_RUNS_ROOT, `${runId}.progress.json`);
/** Namespaced id the Logs page/tail endpoint uses (see src/lib/logs.ts). */
const logFileRel = (runId: string) => `${AGENT_RUNS_PREFIX}/${runId}.log`;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readPid(runId: string): Promise<number | null> {
  try {
    const n = parseInt((await fs.readFile(pidPathFor(runId), "utf8")).trim(), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function statusForRun(runId: string, pid: number | null): RunStatus {
  const running = pid != null && pidAlive(pid);
  return {
    slug: runId,
    running,
    pid: running ? pid : null,
    logFile: logFileRel(runId),
  };
}

/** Live process status of one run. */
export async function runStatus(runId: string): Promise<RunStatus> {
  return statusForRun(runId, await readPid(runId));
}

/**
 * Strip the admin's own `next dev` injected bundler/runtime vars so they don't
 * leak into the orchestrator (and, through it, `claude`). Mirrors runner.ts's
 * childEnv — spawned children must not inherit TURBOPACK/__NEXT*.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === "TURBOPACK" ||
      key === "NEXT_RUNTIME" ||
      key.startsWith("__NEXT") ||
      key.startsWith("__TURBOPACK") ||
      key.startsWith("TURBOPACK_")
    ) {
      delete env[key];
    }
  }
  env.FORCE_COLOR = "0";
  return env;
}

type SpecStep = { agent: string; label: string };

type Spec = {
  runId: string;
  kind: "agent" | "pipeline";
  slug: string;
  name: string;
  agentsRoot: string;
  inputs: Record<string, string>;
  steps: SpecStep[];
  logPath: string;
  logFile: string;
  progressPath: string;
  claudeBin: string;
  readOnlyTools: string[];
  /** Per-launch overrides (from the Run dialog); each null field falls back to
   *  the agent's frontmatter, then a built-in default. */
  config: RunConfig;
  /** Per-run scratch dir the orchestrator uses when a step needs a writable cwd
   *  and neither the override nor the agent specifies one. */
  scratchCwd: string;
  /** Defaults the orchestrator applies when nothing else sets a value. */
  defaults: { timeoutSec: number };
  /** Concurrency semaphore: at most `maxConcurrent` runs execute a step at once. */
  maxConcurrent: number;
  slotsDir: string;
  /** Optional webhook POSTed a JSON summary when the run finishes (or null). */
  notifyWebhook: string | null;
};

/** Merge nullable override fields over a base config (override wins when set). */
function mergeConfig(base: RunConfig, over: RunConfig): RunConfig {
  return {
    maxTurns: over.maxTurns ?? base.maxTurns ?? null,
    timeoutSec: over.timeoutSec ?? base.timeoutSec ?? null,
    permissionMode: over.permissionMode ?? base.permissionMode ?? null,
    cwd: over.cwd ?? base.cwd ?? null,
  };
}

/** Initial progress skeleton so the console shows steps before the run writes. */
function initialProgress(spec: Spec): RunProgress {
  return {
    runId: spec.runId,
    kind: spec.kind,
    slug: spec.slug,
    name: spec.name,
    logFile: spec.logFile,
    state: "starting",
    inputs: spec.inputs,
    steps: spec.steps.map((s, i): RunStep => ({
      index: i,
      agent: s.agent,
      label: s.label,
      state: "pending",
      startedAt: null,
      endedAt: null,
      usage: null,
    })),
    currentStep: null,
    startedAt: null,
    endedAt: null,
    error: null,
    config: spec.config,
    usage: null,
    artifacts: [],
  };
}

/**
 * Spawn the orchestrator DETACHED (own session/process group) so the run
 * outlives the request and an `admin.service` restart — same lifecycle as the
 * app-script runner. Returns the new runId.
 */
async function spawnRun(spec: Spec): Promise<string> {
  const { runId } = spec;
  await fs.mkdir(AGENT_RUNS_ROOT, { recursive: true });
  await fs.writeFile(specPathFor(runId), JSON.stringify(spec, null, 2));
  // Seed progress up-front so the console renders the step list immediately.
  await fs.writeFile(
    progressPathFor(runId),
    JSON.stringify(initialProgress(spec), null, 2),
  );

  const fd = openSync(logPathFor(runId), "a");
  try {
    const child = spawn(process.execPath, [ORCHESTRATOR, specPathFor(runId)], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: childEnv(),
    });
    child.unref();
    if (child.pid) await fs.writeFile(pidPathFor(runId), String(child.pid));
  } finally {
    closeSync(fd);
  }
  return runId;
}

function buildSpec(
  kind: "agent" | "pipeline",
  slug: string,
  name: string,
  steps: SpecStep[],
  inputs: Record<string, string>,
  config: RunConfig,
): Spec {
  const runId = newRunId(kind, slug);
  return {
    runId,
    kind,
    slug,
    name,
    agentsRoot: AGENTS_ROOT,
    inputs,
    steps,
    logPath: logPathFor(runId),
    logFile: logFileRel(runId),
    progressPath: progressPathFor(runId),
    claudeBin: CLAUDE_BIN,
    readOnlyTools: [...READ_ONLY_TOOLS],
    config,
    scratchCwd: path.join(AGENT_RUNS_ROOT, `${runId}.cwd`),
    defaults: { timeoutSec: DEFAULT_TIMEOUT_SEC },
    maxConcurrent: MAX_CONCURRENT,
    slotsDir: SLOTS_DIR,
    notifyWebhook: NOTIFY_WEBHOOK,
  };
}

/** Drop undefined fields so overrides only carry what the caller actually set. */
function cleanOverrides(o: RunConfig | undefined): RunConfig {
  return {
    maxTurns: o?.maxTurns ?? null,
    timeoutSec: o?.timeoutSec ?? null,
    permissionMode: o?.permissionMode ?? null,
    cwd: o?.cwd ?? null,
  };
}

/** Start a single agent run. Returns the new runId. */
export function startAgentRun(
  agent: Agent,
  inputs: Record<string, string>,
  overrides?: RunConfig,
): Promise<string> {
  // Base config = the agent's own frontmatter; the dialog's overrides win.
  // (permissionMode is validated against PERMISSION_MODES when parsed.)
  const base: RunConfig = {
    maxTurns: agent.maxTurns,
    timeoutSec: agent.timeoutSec,
    permissionMode: agent.permissionMode as RunConfig["permissionMode"],
    cwd: agent.cwd,
  };
  return spawnRun(
    buildSpec(
      "agent",
      agent.slug,
      agent.name || agent.slug,
      [{ agent: agent.slug, label: agent.name || agent.slug }],
      inputs,
      mergeConfig(base, cleanOverrides(overrides)),
    ),
  );
}

/** Start a pipeline run (chains its agents through a cumulative context). */
export function startPipelineRun(
  pipeline: Pipeline,
  inputs: Record<string, string>,
  overrides?: RunConfig,
): Promise<string> {
  // Pipelines have no frontmatter config of their own — each step's agent
  // supplies its own (read by the orchestrator). Overrides apply run-wide.
  return spawnRun(
    buildSpec(
      "pipeline",
      pipeline.slug,
      pipeline.name || pipeline.slug,
      pipeline.steps.map((s) => ({
        agent: s.agent,
        label: s.as ? `${s.as} · ${s.agent}` : s.agent,
      })),
      inputs,
      cleanOverrides(overrides),
    ),
  );
}

/**
 * Re-run a past run with the same kind/slug/inputs (and optionally new config
 * overrides). Reads the original spec sidecar. Returns the new runId.
 */
export async function rerunRun(
  runId: string,
  overrides?: RunConfig,
): Promise<string> {
  const raw = await fs.readFile(specPathFor(runId), "utf8").catch(() => null);
  if (!raw) throw new Error("Original run spec is gone — cannot re-run");
  const old = JSON.parse(raw) as Spec;
  const config = mergeConfig(old.config ?? {}, cleanOverrides(overrides));
  const fresh = buildSpec(
    old.kind,
    old.slug,
    old.name,
    old.steps,
    old.inputs,
    config,
  );
  return spawnRun(fresh);
}

/** Read a run's structured progress (null if the runId is unknown). */
export async function readProgress(runId: string): Promise<RunProgress | null> {
  try {
    return JSON.parse(await fs.readFile(progressPathFor(runId), "utf8"));
  } catch {
    return null;
  }
}

/** Effective lifecycle: a run whose process died mid-flight reads as failed. */
function effectiveState(p: RunProgress, running: boolean): RunLifecycle {
  if (running) return p.state;
  if (p.state === "running" || p.state === "starting" || p.state === "queued")
    return "failed";
  return p.state;
}

const ACTIVE_STATES: RunLifecycle[] = ["queued", "starting", "running"];

/**
 * If a run's file still says active but its process is gone (e.g. the box
 * rebooted mid-run), persist a "failed" state so history/console stop showing a
 * phantom "running". Returns the (possibly rewritten) progress.
 */
async function reconcileProgress(
  runId: string,
  p: RunProgress,
  running: boolean,
): Promise<RunProgress> {
  if (running || !ACTIVE_STATES.includes(p.state)) return p;
  const cur = p.currentStep != null ? p.steps[p.currentStep] : null;
  if (cur && cur.state === "running") {
    cur.state = "failed";
    cur.endedAt = cur.endedAt ?? new Date().toISOString();
  }
  p.state = "failed";
  p.error = p.error ?? "process exited before completing (reconciled)";
  p.endedAt = p.endedAt ?? new Date().toISOString();
  p.currentStep = null;
  await fs
    .writeFile(progressPathFor(runId), JSON.stringify(p, null, 2))
    .catch(() => {});
  return p;
}

/** Total run cost = sum of any step usage that reported a cost. */
function totalCost(p: RunProgress): number | null {
  let sum = 0;
  let any = false;
  for (const s of p.steps) {
    if (s.usage?.costUsd != null) {
      sum += s.usage.costUsd;
      any = true;
    }
  }
  return any ? sum : null;
}

/**
 * All runs, newest first — the run history. Scans the per-run progress files
 * under AGENT_RUNS_ROOT (each is a self-contained record + a sibling `.log`),
 * reconciling dead-but-"running" entries and pruning ones past retention.
 */
export async function listRuns(): Promise<RunSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(AGENT_RUNS_ROOT);
  } catch {
    return [];
  }
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const out: RunSummary[] = [];
  for (const f of entries) {
    if (!f.endsWith(".progress.json")) continue;
    const runId = f.slice(0, -".progress.json".length);
    let p = await readProgress(runId);
    if (!p) continue;
    const pid = await readPid(runId);
    const running = pid != null && pidAlive(pid);
    p = await reconcileProgress(runId, p, running);

    // Retention: drop finished runs older than the window entirely.
    const ended = p.endedAt ? Date.parse(p.endedAt) : NaN;
    if (!running && Number.isFinite(ended) && ended < cutoff) {
      await deleteRun(runId);
      continue;
    }

    out.push({
      runId: p.runId,
      kind: p.kind,
      slug: p.slug,
      name: p.name,
      logFile: p.logFile,
      state: effectiveState(p, running),
      running,
      stepsDone: p.steps.filter((s) => s.state === "done").length,
      stepsTotal: p.steps.length,
      startedAt: p.startedAt,
      endedAt: p.endedAt,
      costUsd: totalCost(p),
    });
  }
  out.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  return out;
}

/** Delete every finished (not-running) run. Returns how many were removed. */
export async function clearFinishedRuns(): Promise<number> {
  const runs = await listRuns();
  let n = 0;
  for (const r of runs) {
    if (r.running) continue;
    await deleteRun(r.runId);
    n++;
  }
  return n;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stop a run: signal its process group (SIGTERM → SIGKILL), clear the pid. */
export async function stopRun(runId: string): Promise<RunStatus> {
  const pid = await readPid(runId);
  if (pid != null && pidAlive(pid)) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    for (let i = 0; i < 15 && pidAlive(pid); i++) await sleep(200);
    if (pidAlive(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    await fs
      .appendFile(
        logPathFor(runId),
        `\n[agent-run ${new Date().toISOString()}] stopped by admin\n`,
      )
      .catch(() => {});
  }
  await fs.rm(pidPathFor(runId), { force: true });

  // Reflect the stop in the progress file so the console/history show it.
  const progress = await readProgress(runId);
  if (progress && (progress.state === "running" || progress.state === "starting")) {
    const cur =
      progress.currentStep != null ? progress.steps[progress.currentStep] : null;
    if (cur && cur.state === "running") {
      cur.state = "failed";
      cur.endedAt = new Date().toISOString();
    }
    progress.state = "stopped";
    progress.currentStep = null;
    progress.endedAt = new Date().toISOString();
    await fs
      .writeFile(progressPathFor(runId), JSON.stringify(progress, null, 2))
      .catch(() => {});
  }

  return statusForRun(runId, null);
}

/** Delete a run's files (used by history to clear an entry). */
export async function deleteRun(runId: string): Promise<void> {
  await Promise.all([
    ...[
      logPathFor(runId),
      pidPathFor(runId),
      specPathFor(runId),
      progressPathFor(runId),
    ].map((p) => fs.rm(p, { force: true })),
    fs.rm(path.join(AGENT_RUNS_ROOT, `${runId}.cwd`), {
      force: true,
      recursive: true,
    }),
  ]);
}
