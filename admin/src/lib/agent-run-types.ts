// Pure, dependency-free types shared by BOTH server and client (and mirrored by
// the plain-JS orchestrator scripts/agent-run.mjs). No "server-only" import here
// so client components can import these types. Keep in sync with agent-run.mjs.

export type StepState = "pending" | "running" | "done" | "failed";

/**
 * Token/cost/timing usage for one `claude -p` invocation, parsed from its final
 * `result` event. Any field is null when the CLI didn't report it.
 */
export type RunUsage = {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  turns: number | null;
  durationMs: number | null;
};

/** Empty usage accumulator (all nulls). */
export const EMPTY_USAGE: RunUsage = {
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  turns: null,
  durationMs: null,
};

/** One step of a run: an agent invocation (a single-agent run has exactly one). */
export type RunStep = {
  index: number;
  /** Agent slug being invoked. */
  agent: string;
  /** Display label — `as · agent` for a re-used pipeline agent, else the agent. */
  label: string;
  state: StepState;
  startedAt: string | null;
  endedAt: string | null;
  /** Usage for this step's `claude -p` call (null until it reports/finishes). */
  usage?: RunUsage | null;
};

export type RunLifecycle =
  | "queued"
  | "starting"
  | "running"
  | "done"
  | "failed"
  | "stopped";

/**
 * Per-run execution knobs, resolved from agent/pipeline frontmatter + optional
 * per-launch overrides from the Run dialog. Mirrored into the spec the
 * orchestrator reads. All optional — omitted fields fall back to safe defaults.
 */
export type RunConfig = {
  /** Cap on agent turns per step (`--max-turns`). */
  maxTurns?: number | null;
  /** Wall-clock timeout per step, in seconds (orchestrator kills the child). */
  timeoutSec?: number | null;
  /** Claude permission mode (`--permission-mode`). */
  permissionMode?: PermissionMode | null;
  /** Working directory to run in (writes land here). */
  cwd?: string | null;
};

export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions";

export const PERMISSION_MODES: PermissionMode[] = [
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
];

/** Structured, inspectable progress for one agent/pipeline run. */
export type RunProgress = {
  /** Unique id for THIS launch (a new one every Run) — keys all run files. */
  runId: string;
  kind: "agent" | "pipeline";
  /** Agent/pipeline slug that was run. */
  slug: string;
  /** Display name of the agent/pipeline. */
  name: string;
  /** Log file path relative to /tmp (the id the Logs page/tail endpoint uses). */
  logFile: string;
  state: RunLifecycle;
  inputs: Record<string, string>;
  steps: RunStep[];
  /** Index of the step currently running (null when none is). */
  currentStep: number | null;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  /** Resolved execution config for this run (cost/safety knobs). */
  config?: RunConfig;
  /** Summed usage across all steps that have reported. */
  usage?: RunUsage | null;
  /** Files created/modified during the run (best-effort, from Write/Edit tools). */
  artifacts?: string[];
};

/** Lightweight summary used by the dock/history list and card indicators. */
export type RunSummary = {
  runId: string;
  kind: "agent" | "pipeline";
  slug: string;
  name: string;
  logFile: string;
  state: RunLifecycle;
  /** True when the run's process is currently alive. */
  running: boolean;
  stepsDone: number;
  stepsTotal: number;
  startedAt: string | null;
  endedAt: string | null;
  /** Total cost in USD across steps, when the CLI reported it. */
  costUsd?: number | null;
};
