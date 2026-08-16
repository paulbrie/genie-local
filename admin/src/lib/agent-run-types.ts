// Pure, dependency-free types shared by BOTH server and client (and mirrored by
// the plain-JS orchestrator scripts/agent-run.mjs). No "server-only" import here
// so client components can import these types. Keep in sync with agent-run.mjs.

export type StepState = "pending" | "running" | "done" | "failed";

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
};

export type RunLifecycle =
  | "starting"
  | "running"
  | "done"
  | "failed"
  | "stopped";

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
};
