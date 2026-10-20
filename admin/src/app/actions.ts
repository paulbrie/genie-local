"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { TASK_STATUSES, type TaskStatus } from "@/db/schema";
import type {
  PermissionMode,
  RunConfig,
  RunProgress,
  RunSummary,
} from "@/lib/agent-run-types";
import {
  type Agent,
  type AgentFields,
  type AgentKind,
  deleteAgentSource,
  duplicateAgentSource,
  interpolatePrompt,
  isValidAgentSlug,
  listAgents,
  listPipelines,
  MAX_AGENT_BYTES,
  PERMISSION_MODES,
  type Pipeline,
  type PipelineFields,
  readAgentParsed,
  writeAgentFields,
} from "@/lib/agents";
import {
  clearFinishedRuns,
  deleteRun,
  listRuns,
  readProgress,
  rerunRun,
  runStatus,
  startAgentRun,
  startPipelineRun,
  stopRun,
} from "@/lib/agent-runner";
import {
  addNote,
  addTask,
  addTaskComment,
  deleteNote,
  deleteTask,
  deleteTaskAttachment,
  deleteTaskComment,
  getTaskComment,
  commentFileCount,
  commentFilePaths,
  taskInProject,
  delegatedTickets,
  getTask,
  assignTask,
  getAppRunTarget,
  getProjectIdBySlug,
  reorderNotes,
  reorderTasks,
  setProjectArchived,
  moveTask,
  setTaskStatus,
  updateAppPort,
  updateNote,
  updateTask,
} from "@/lib/data";
import {
  type DeployStatus,
  deployStatus,
  startDeploy,
} from "@/lib/deploy";
import {
  applyNginx,
  portTakenBy,
  previewPortChange,
  type NginxApplyResult,
  type PortChangePreview,
} from "@/lib/nginx";
import {
  listeningPortPids,
  restartApp,
  startApp,
  statusForWithPort,
  stopApp,
  type RunStatus,
} from "@/lib/runner";
import {
  archiveDiagram,
  createDiagram,
  DIAGRAM_FORMATS,
  MAX_DIAGRAM_BYTES,
  purgeDiagram,
  renameDiagram,
  restoreDiagram,
  updateDiagram,
} from "@/lib/diagrams";
import { requireAdmin } from "@/lib/require-admin";
import { getProjectDetail, rescanProject, scanAndPersist } from "@/lib/scan";
import { listTerminals } from "@/lib/terminals";
import { readScripts } from "@/lib/signals";
import {
  NEW_AGENT,
  newAgentName,
  startAgent,
  clearContext,
  commentBrief,
  delegateBrief,
  delegateTargets,
  sendBrief,
  type DelegateTarget,
} from "@/lib/task-delegate";
import {
  removeAttachmentFile,
  removeTaskAttachmentDir,
} from "@/lib/task-attachments";

const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^/\\]+$/, "slug must not contain path separators");

async function requireProjectId(slug: string): Promise<number> {
  const parsed = slugSchema.parse(slug);
  const id = await getProjectIdBySlug(parsed);
  if (id === null) throw new Error(`Unknown project: ${parsed}`);
  return id;
}

/**
 * Refresh a project's pages after a change: the layout (header, tab counts)
 * and every tab under /projects/<slug>/… (scripts, tasks, notes, git).
 */
function revalidateProject() {
  revalidatePath("/projects/[slug]", "layout");
}

export async function rescanAllAction() {
  await requireAdmin();
  await scanAndPersist();
  revalidatePath("/");
}

export async function rescanProjectAction(slug: string) {
  await requireAdmin();
  const parsed = slugSchema.parse(slug);
  await rescanProject(parsed);
  revalidateProject();
  revalidatePath("/");
}

/**
 * "Delete" a project = archive it: remove it from the dashboard/scan without
 * touching the files on disk. The DB row + history are kept so it can be
 * restored. Reversible via restoreProjectAction.
 */
export async function deleteProjectAction(slug: string) {
  await requireAdmin();
  const id = await requireProjectId(slug);
  await setProjectArchived(id, true);
  revalidatePath("/");
  revalidateProject();
}

/** Restore a previously-archived project so the scan tracks it again. */
export async function restoreProjectAction(slug: string) {
  await requireAdmin();
  const id = await requireProjectId(slug);
  await setProjectArchived(id, false);
  revalidatePath("/");
  revalidateProject();
}

export async function addNoteAction(slug: string, formData: FormData) {
  await requireAdmin();
  const id = await requireProjectId(slug);
  const body = z.string().trim().min(1).max(5000).parse(formData.get("body"));
  await addNote(id, body);
  revalidateProject();
}

export async function updateNoteAction(
  slug: string,
  noteId: number,
  body: string,
) {
  await requireAdmin();
  const id = await requireProjectId(slug);
  const parsedNoteId = z.number().int().positive().parse(noteId);
  const parsedBody = z.string().trim().min(1).max(5000).parse(body);
  await updateNote(id, parsedNoteId, parsedBody);
  revalidateProject();
}

export async function deleteNoteAction(slug: string, noteId: number) {
  await requireAdmin();
  const id = await requireProjectId(slug);
  const parsedNoteId = z.number().int().positive().parse(noteId);
  await deleteNote(id, parsedNoteId);
  revalidateProject();
}

export async function reorderNotesAction(slug: string, orderedIds: number[]) {
  await requireAdmin();
  const id = await requireProjectId(slug);
  const ids = z.array(z.number().int().positive()).max(1000).parse(orderedIds);
  await reorderNotes(id, ids);
  revalidateProject();
}

export async function addTaskAction(slug: string, formData: FormData) {
  await requireAdmin();
  const id = await requireProjectId(slug);
  const title = z.string().trim().min(1).max(500).parse(formData.get("title"));
  const rawDesc = formData.get("description");
  const description = z
    .string()
    .trim()
    .max(5000)
    .optional()
    .parse(typeof rawDesc === "string" && rawDesc.trim() ? rawDesc : undefined);
  const taskId = await addTask(id, title, description ?? null);
  revalidateProject();
  // The caller uploads any files picked or pasted in the form to this task next.
  return taskId;
}

const taskStatusSchema = z.enum(TASK_STATUSES);
// A git object name, abbreviated (≥ 4) or full (40, or 64 for SHA-256 repos).
const COMMIT_SHA_RE = /^[0-9a-f]{4,64}$/i;

/** A board drop: the task's new column and the project's new top→bottom order. */
export async function moveTaskAction(
  slug: string,
  taskId: number,
  status: TaskStatus,
  orderedIds: number[],
) {
  await requireAdmin();
  const id = await requireProjectId(slug);
  await moveTask(
    id,
    z.number().int().positive().parse(taskId),
    taskStatusSchema.parse(status),
    z.array(z.number().int().positive()).max(1000).parse(orderedIds),
  );
  revalidateProject();
}

export async function updateTaskAction(
  slug: string,
  taskId: number,
  fields: {
    title: string;
    description: string | null;
    status: TaskStatus;
    commitSha: string | null;
  },
) {
  await requireAdmin();
  const id = await requireProjectId(slug);
  const parsedTaskId = z.number().int().positive().parse(taskId);
  const trimmedDesc = fields.description?.trim() ?? "";
  const sha = fields.commitSha?.trim() ?? "";
  await updateTask(id, parsedTaskId, {
    title: z.string().trim().min(1).max(500).parse(fields.title),
    description: z.string().max(5000).nullable().parse(trimmedDesc || null),
    status: taskStatusSchema.parse(fields.status),
    commitSha: sha ? parseCommitSha(sha) : null,
  });
  revalidateProject();
}

// Thrown as a plain message: the dialog shows it as is (a ZodError would print as JSON).
function parseCommitSha(sha: string): string {
  if (!COMMIT_SHA_RE.test(sha)) {
    throw new Error("Commit must be a git sha (4 to 64 hex characters)");
  }
  return sha.toLowerCase();
}

/** Live Claude terminals for the ticket drawer's Delegate picker. */
export async function delegateTargetsAction(
  slug: string,
): Promise<DelegateTarget[]> {
  await requireAdmin();
  await requireProjectId(slug);
  return delegateTargets(slug);
}

/**
 * Delegate a ticket to a Claude terminal: type a one-line brief into it (it
 * reads the ticket through the local-genie MCP) and record the assignee.
 */
export async function delegateTaskAction(
  slug: string,
  taskId: number,
  terminal: string,
  note: string | null,
  /** /clear the terminal's Claude first, so it starts the ticket on a clean slate (idle terminals only) */
  freshContext = false,
): Promise<{ ok: true; queued: boolean } | { ok: false; error: string }> {
  await requireAdmin();
  const id = await requireProjectId(slug);
  const task = await getTask(id, z.number().int().positive().parse(taskId));
  if (!task) return { ok: false, error: `No task ${taskId} in project ${slug}` };
  const name = z.string().trim().min(1).max(100).parse(terminal);
  const trimmedNote = z.string().max(2000).parse(note ?? "").trim() || null;
  // One in-progress ticket per agent: one already on another isn't given this one.
  const busy = (await delegatedTickets()).find(
    (x) => x.assignee === name && x.status === "in_progress" && x.id !== task.id,
  );
  if (busy) {
    return { ok: false, error: `${name} is on #${busy.id} (${busy.project}), still in progress: pick a free agent` };
  }
  // Returned, not thrown: in production a thrown action error reaches the page redacted.
  try {
    if (z.boolean().parse(freshContext)) await clearContext(name);
    const status = await sendBrief(name, delegateBrief(slug, task, trimmedNote));
    await assignTask(id, task.id, name, trimmedNote, freshContext);
    revalidateProject();
    // A working terminal holds the brief until its current turn ends.
    return { ok: true, queued: status === "claude-working" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Delegate a ticket to a new agent: a fresh Claude terminal named
 * "<project>-<ticket id>", started in the project's folder with the brief as
 * its first prompt (Opus, high effort, auto permissions, as the team's agents).
 */
export async function delegateToNewAgentAction(
  slug: string,
  taskId: number,
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  await requireAdmin();
  const id = await requireProjectId(slug);
  const task = await getTask(id, z.number().int().positive().parse(taskId));
  const detail = await getProjectDetail(slug);
  if (!task || !detail) return { ok: false, error: `No task ${taskId} in project ${slug}` };
  const name = newAgentName(slug, task.id);
  if ((await listTerminals()).some((t) => t.name === name)) {
    return { ok: false, error: `A terminal "${name}" already exists: pick it under Delegate to` };
  }
  try {
    await startAgent(name, detail.project.path, delegateBrief(slug, task, null));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  await assignTask(id, task.id, name, `a new agent (${NEW_AGENT.model}, ${NEW_AGENT.effort} effort) in ${detail.project.path}`);
  revalidateProject();
  return { ok: true, name };
}

export async function deleteTaskAction(slug: string, taskId: number) {
  await requireAdmin();
  const id = await requireProjectId(slug);
  const parsedTaskId = z.number().int().positive().parse(taskId);
  await deleteTask(id, parsedTaskId);
  await removeTaskAttachmentDir(parsedTaskId);
  revalidateProject();
}

export async function deleteTaskAttachmentAction(
  slug: string,
  attachmentId: number,
) {
  await requireAdmin();
  const id = await requireProjectId(slug);
  const rel = await deleteTaskAttachment(
    id,
    z.number().int().positive().parse(attachmentId),
  );
  if (rel) await removeAttachmentFile(rel);
  revalidateProject();
}

/** What happened to the assignee's notification when a comment was posted. */
export type CommentNotice =
  | { terminal: null }
  /** reopened: the ticket was done and is back in progress while the agent works on the comment */
  | { terminal: string; sent: true; queued: boolean; reopened: boolean }
  | { terminal: string; sent: false; reason: string };

/**
 * Comment on a ticket as the user. If the ticket is delegated to a terminal,
 * the comment is also typed into it (commentBrief) so the agent reads it now;
 * a terminal that can't take it (gone, waiting on a prompt) doesn't block the
 * comment: the reply says why it wasn't told. A done ticket whose agent was
 * told goes back to in progress (the agent sets it done again when finished);
 * one whose agent couldn't be told stays done: nobody is working on it.
 */
export async function addTaskCommentAction(
  slug: string,
  taskId: number,
  body: string,
  /** files follow (uploaded by the page): the agent is told after, by notifyCommentAction */
  withFiles = false,
): Promise<{ commentId: number; notice: CommentNotice | null }> {
  await requireAdmin();
  const id = await requireProjectId(slug);
  const parsedTaskId = z.number().int().positive().parse(taskId);
  const parsedBody = z.string().trim().min(1).max(5000).parse(body);
  const commentId = await addTaskComment(id, parsedTaskId, parsedBody);
  if (commentId == null) throw new Error(`No task ${parsedTaskId} in project ${slug}`);
  revalidateProject();
  if (z.boolean().parse(withFiles)) return { commentId, notice: null };
  return { commentId, notice: await notifyAssignee(id, slug, parsedTaskId, parsedBody, 0) };
}

/** Tell the ticket's agent about a comment whose files have been uploaded since. */
export async function notifyCommentAction(
  slug: string,
  taskId: number,
  commentId: number,
): Promise<CommentNotice> {
  await requireAdmin();
  const id = await requireProjectId(slug);
  const parsedTaskId = z.number().int().positive().parse(taskId);
  const comment = await getTaskComment(parsedTaskId, z.number().int().positive().parse(commentId));
  if (!comment || !(await taskInProject(id, parsedTaskId))) throw new Error(`No comment ${commentId} on task ${taskId}`);
  return notifyAssignee(id, slug, parsedTaskId, comment.body, await commentFileCount(comment.id));
}

async function notifyAssignee(
  projectId: number,
  slug: string,
  taskId: number,
  body: string,
  files: number,
): Promise<CommentNotice> {
  const id = projectId;
  const task = await getTask(id, taskId);
  if (!task?.assignee) return { terminal: null };
  const reopen = task.status === "done";
  try {
    const status = await sendBrief(task.assignee, commentBrief(slug, task, body, reopen, files));
    if (reopen) {
      await setTaskStatus(id, task.id, "in_progress");
      revalidateProject();
    }
    return { terminal: task.assignee, sent: true, queued: status === "claude-working", reopened: reopen };
  } catch (err) {
    return {
      terminal: task.assignee,
      sent: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function deleteTaskCommentAction(slug: string, commentId: number) {
  await requireAdmin();
  const id = await requireProjectId(slug);
  const parsed = z.number().int().positive().parse(commentId);
  const files = await commentFilePaths(parsed);
  // Its files leave with it, from disk too (the rows go by cascade).
  if (await deleteTaskComment(id, parsed)) {
    await Promise.all(files.map((f) => removeAttachmentFile(f).catch(() => {})));
  }
  revalidateProject();
}

export async function reorderTasksAction(slug: string, orderedIds: number[]) {
  await requireAdmin();
  const id = await requireProjectId(slug);
  const ids = z.array(z.number().int().positive()).max(1000).parse(orderedIds);
  await reorderTasks(id, ids);
  revalidateProject();
}

/**
 * Update an app's port, then regenerate + reload Nginx so the change takes
 * effect immediately. Returns the Nginx apply result for UI feedback. Refuses a
 * port another app already has (T241/T242: two apps on one port means one
 * server answers for both), before touching the DB.
 */
export async function setAppPortAction(
  slug: string,
  appId: number,
  port: number | null,
): Promise<NginxApplyResult> {
  await requireAdmin();
  const projectId = await requireProjectId(slug);
  const parsedAppId = z.number().int().positive().parse(appId);
  const parsedPort =
    port === null
      ? null
      : z.number().int().min(1).max(65535).parse(port);

  const taken = await portTakenBy(parsedAppId, parsedPort);
  if (taken) return { ok: false, message: taken };
  await updateAppPort(projectId, parsedAppId, parsedPort);
  const result = await applyNginx();
  revalidateProject();
  revalidatePath("/nginx");
  return result;
}

/**
 * What giving an app a port would do, without doing it (T242): the conflicts
 * (another app's port, a live process's, outside the range, a running app to
 * restart) and the generated include's diff, for the Nginx page's confirm step.
 */
export async function previewAppPortAction(
  slug: string,
  appId: number,
  port: number | null,
): Promise<PortChangePreview> {
  await requireAdmin();
  await requireProjectId(slug);
  const parsedAppId = z.number().int().positive().parse(appId);
  const parsedPort =
    port === null
      ? null
      : z.number().int().min(1).max(65535).parse(port);
  return previewPortChange(parsedAppId, parsedPort);
}

const appIdSchema = z.number().int().positive();
// npm script names: letters/digits and the usual separators (dev, build:prod…).
const scriptNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9:._-]+$/, "invalid script name");

/** Load the app's run target (dir/port/slugs), scoped to the owning project. */
async function requireAppTarget(slug: string, appId: number) {
  const projectId = await requireProjectId(slug);
  const parsedAppId = appIdSchema.parse(appId);
  const target = await getAppRunTarget(projectId, parsedAppId);
  if (!target) throw new Error(`Unknown app ${parsedAppId} in project ${slug}`);
  return target;
}

/** Validate a script name AND that it actually exists in the app's package.json. */
async function requireScript(
  target: { path: string; projectSlug: string; appSlug: string },
  script: string,
): Promise<string> {
  const parsed = scriptNameSchema.parse(script);
  const scripts = await readScripts(target.path);
  if (!(parsed in scripts)) {
    throw new Error(
      `No "${parsed}" script in ${target.projectSlug}/${target.appSlug}`,
    );
  }
  return parsed;
}

/** Start one app+script (detached, logs to /tmp/projects/<app>-<script>.log). */
export async function startAppAction(
  slug: string,
  appId: number,
  script: string,
): Promise<RunStatus> {
  await requireAdmin();
  const t = await requireAppTarget(slug, appId);
  const parsedScript = await requireScript(t, script);
  const status = await startApp({
    dir: t.path,
    projectSlug: t.projectSlug,
    appSlug: t.appSlug,
    port: t.port,
    script: parsedScript,
  });
  revalidateProject();
  return status;
}

export async function stopAppAction(
  slug: string,
  appId: number,
  script: string,
): Promise<RunStatus> {
  await requireAdmin();
  const t = await requireAppTarget(slug, appId);
  // Stopping only needs a well-formed name (the unit may be a since-removed script).
  const parsedScript = scriptNameSchema.parse(script);
  const status = await stopApp(t.projectSlug, t.appSlug, parsedScript);
  revalidateProject();
  return status;
}

export async function restartAppAction(
  slug: string,
  appId: number,
  script: string,
): Promise<RunStatus> {
  await requireAdmin();
  const t = await requireAppTarget(slug, appId);
  const parsedScript = await requireScript(t, script);
  const status = await restartApp({
    dir: t.path,
    projectSlug: t.projectSlug,
    appSlug: t.appSlug,
    port: t.port,
    script: parsedScript,
  });
  revalidateProject();
  return status;
}

/**
 * Poll the live run status of all of an app's scripts in one call (no
 * revalidation). One call per app, not per script: the client runs server
 * actions one at a time, so per-script polling on an app with dozens of scripts
 * kept the queue full and starved every other action on the page (Add task…).
 */
export async function appStatusesAction(
  slug: string,
  appId: number,
  scripts: string[],
): Promise<Record<string, RunStatus>> {
  await requireAdmin();
  const t = await requireAppTarget(slug, appId);
  const parsed = z.array(scriptNameSchema).max(500).parse(scripts);
  // Port fallback (see statusForWithPort) so these dots agree with the dashboard
  // when the pid file is stale or the server was started outside the runner.
  const portPids = await listeningPortPids();
  const statuses = await Promise.all(
    parsed.map((s) =>
      statusForWithPort(t.projectSlug, t.appSlug, s, t.port, portPids),
    ),
  );
  return Object.fromEntries(parsed.map((s, i) => [s, statuses[i]]));
}

// ---------------------------------------------------------------------------
// Deploy — build the prod bundle from the current source and restart /admin.
// Dev (/admin-dev) start/stop lives on the Services page (plain systemctl).
// ---------------------------------------------------------------------------

/** Build + deploy prod (optionally running migrations first). Detached. */
export async function deployProdAction(
  migrate: boolean,
): Promise<{ ok: boolean; output?: string; error?: string }> {
  await requireAdmin();
  const result = await startDeploy(z.boolean().parse(migrate));
  revalidatePath("/services");
  return result;
}

/** Poll prod/dev service state + last deploy outcome (no revalidation). */
export async function deployStatusAction(): Promise<DeployStatus> {
  await requireAdmin();
  return deployStatus();
}

// ---------------------------------------------------------------------------
// Agents & pipelines — run markdown-defined agents/pipelines via `claude -p`.
// ---------------------------------------------------------------------------

// One input value per declared input; generous cap for pasted context.
const inputsSchema = z.record(z.string(), z.string().max(50_000));

/** Keep only the values the target actually declares as inputs. */
function pickInputs(
  declared: string[],
  provided: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of declared) out[key] = provided[key] ?? "";
  return out;
}

// A run id is filesystem-safe by construction (see agent-runner newRunId).
const runIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+$/, "invalid run id");

const permissionModeSchema = z.enum(
  PERMISSION_MODES as unknown as [PermissionMode, ...PermissionMode[]],
);

// Per-launch overrides from the Run dialog. All optional; null/absent → the
// agent's frontmatter (then a built-in default) decides.
const runConfigSchema = z
  .object({
    maxTurns: z.number().int().min(1).max(1000).nullable().optional(),
    timeoutSec: z.number().int().min(1).max(86_400).nullable().optional(),
    permissionMode: permissionModeSchema.nullable().optional(),
    cwd: z.string().max(1000).nullable().optional(),
  })
  .optional();

/** Start a single agent run (detached). Returns the new run id. */
export async function runAgentAction(
  slug: string,
  inputs: Record<string, string>,
  config?: RunConfig,
): Promise<string> {
  await requireAdmin();
  const parsedSlug = slugSchema.parse(slug);
  const parsedInputs = inputsSchema.parse(inputs);
  const parsedConfig = runConfigSchema.parse(config);
  const agent = (await listAgents()).find((a) => a.slug === parsedSlug);
  if (!agent) throw new Error(`Unknown agent: ${parsedSlug}`);
  return startAgentRun(agent, pickInputs(agent.inputs, parsedInputs), parsedConfig);
}

/** Start a pipeline run (detached). Returns the new run id. */
export async function runPipelineAction(
  slug: string,
  inputs: Record<string, string>,
  config?: RunConfig,
): Promise<string> {
  await requireAdmin();
  const parsedSlug = slugSchema.parse(slug);
  const parsedInputs = inputsSchema.parse(inputs);
  const parsedConfig = runConfigSchema.parse(config);
  const pipeline = (await listPipelines()).find((p) => p.slug === parsedSlug);
  if (!pipeline) throw new Error(`Unknown pipeline: ${parsedSlug}`);
  return startPipelineRun(
    pipeline,
    pickInputs(pipeline.inputs, parsedInputs),
    parsedConfig,
  );
}

/** Re-run a past run with the same inputs (and optional new overrides). */
export async function rerunRunAction(
  runId: string,
  config?: RunConfig,
): Promise<string> {
  await requireAdmin();
  return rerunRun(runIdSchema.parse(runId), runConfigSchema.parse(config));
}

/** One resolved prompt for the dry-run preview. */
export type PromptPreview = { label: string; agent: string; prompt: string };

/**
 * Build the exact prompt(s) a run would send, WITHOUT spawning anything. For a
 * pipeline, later steps show their `{{output}}` placeholders unresolved (those
 * values don't exist until earlier steps run).
 */
export async function previewRunAction(
  kind: AgentKind,
  slug: string,
  inputs: Record<string, string>,
): Promise<PromptPreview[]> {
  await requireAdmin();
  const k = kindSchema.parse(kind);
  const parsedSlug = slugSchema.parse(slug);
  const parsedInputs = inputsSchema.parse(inputs);
  const agents = await listAgents();
  const bodyOf = (agentSlug: string) =>
    agents.find((a) => a.slug === agentSlug)?.body ?? null;

  if (k === "agent") {
    const agent = agents.find((a) => a.slug === parsedSlug);
    if (!agent) throw new Error(`Unknown agent: ${parsedSlug}`);
    const ctx = pickInputs(agent.inputs, parsedInputs);
    return [
      { label: agent.name || agent.slug, agent: agent.slug, prompt: interpolatePrompt(agent.body, ctx) },
    ];
  }

  const pipeline = (await listPipelines()).find((p) => p.slug === parsedSlug);
  if (!pipeline) throw new Error(`Unknown pipeline: ${parsedSlug}`);
  const ctx = pickInputs(pipeline.inputs, parsedInputs);
  return pipeline.steps.map((s) => {
    const body = bodyOf(s.agent);
    return {
      label: s.as ? `${s.as} · ${s.agent}` : s.agent,
      agent: s.agent,
      prompt: body == null ? `⚠ agent "${s.agent}" not found` : interpolatePrompt(body, ctx),
    };
  });
}

/** Stop an in-flight run by id. */
export async function stopRunByIdAction(runId: string): Promise<RunStatus> {
  await requireAdmin();
  return stopRun(runIdSchema.parse(runId));
}

/** Poll a run's live status + structured step progress (for the run console). */
export async function runProgressByIdAction(
  runId: string,
): Promise<{ status: RunStatus; progress: RunProgress | null }> {
  await requireAdmin();
  const id = runIdSchema.parse(runId);
  const [status, progress] = await Promise.all([runStatus(id), readProgress(id)]);
  return { status, progress };
}

/** The run history + currently-active runs, newest first. */
export async function listRunsAction(): Promise<RunSummary[]> {
  await requireAdmin();
  return listRuns();
}

/** Delete a finished run's files (removes it from history). */
export async function deleteRunAction(runId: string): Promise<void> {
  await requireAdmin();
  await deleteRun(runIdSchema.parse(runId));
}

/** Delete every finished (not-running) run. Returns how many were removed. */
export async function clearFinishedRunsAction(): Promise<number> {
  await requireAdmin();
  return clearFinishedRuns();
}

// ---------------------------------------------------------------------------
// Agent/pipeline authoring — CRUD on the raw markdown files.
// ---------------------------------------------------------------------------

const kindSchema = z.enum(["agent", "pipeline"]);
const agentSlugSchema = z
  .string()
  .refine(isValidAgentSlug, "slug must be kebab-case (a-z, 0-9, -)");

// Frontmatter list items (tool/input/output/step names): safe, no separators.
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, "invalid name");
// Scalar (single line) values, no newlines to keep the frontmatter intact.
const oneLineSchema = z
  .string()
  .max(1000)
  .refine((s) => !/\r?\n/.test(s), "must be a single line");

// A cwd path: no newlines, and disallow the obvious traversal footgun.
const cwdSchema = z
  .string()
  .max(1000)
  .refine((s) => !/\r?\n/.test(s), "must be a single line")
  .nullable();

const agentFieldsSchema: z.ZodType<AgentFields> = z.object({
  name: oneLineSchema,
  description: oneLineSchema,
  model: oneLineSchema.nullable(),
  tools: z.array(tokenSchema).max(64).nullable(),
  inputs: z.array(tokenSchema).max(64),
  outputs: z.array(tokenSchema).max(64),
  body: z.string().max(MAX_AGENT_BYTES),
  maxTurns: z.number().int().min(1).max(1000).nullable(),
  timeoutSec: z.number().int().min(1).max(86_400).nullable(),
  permissionMode: permissionModeSchema.nullable(),
  cwd: cwdSchema,
});

const pipelineFieldsSchema: z.ZodType<PipelineFields> = z.object({
  name: oneLineSchema,
  description: oneLineSchema,
  inputs: z.array(tokenSchema).max(64),
  steps: z
    .array(z.object({ agent: tokenSchema, as: tokenSchema.nullable() }))
    .min(1)
    .max(64),
  body: z.string().max(MAX_AGENT_BYTES),
});

/** Structured fields of one agent/pipeline (for the visual editor). */
export async function getAgentDefAction(
  kind: AgentKind,
  slug: string,
): Promise<Agent | Pipeline> {
  await requireAdmin();
  return readAgentParsed(kindSchema.parse(kind), agentSlugSchema.parse(slug));
}

/** Create or update an agent/pipeline from structured fields, then refresh. */
export async function saveAgentDefAction(
  kind: AgentKind,
  slug: string,
  fields: AgentFields | PipelineFields,
  create: boolean,
): Promise<void> {
  await requireAdmin();
  const k = kindSchema.parse(kind);
  const parsed =
    k === "pipeline"
      ? pipelineFieldsSchema.parse(fields)
      : agentFieldsSchema.parse(fields);
  await writeAgentFields(k, agentSlugSchema.parse(slug), parsed, {
    create: z.boolean().parse(create),
  });
  revalidatePath("/agents");
}

/** Delete an agent/pipeline file, then refresh the page. */
export async function deleteAgentSourceAction(
  kind: AgentKind,
  slug: string,
): Promise<void> {
  await requireAdmin();
  await deleteAgentSource(kindSchema.parse(kind), agentSlugSchema.parse(slug));
  revalidatePath("/agents");
}

const diagramTitleSchema = z.string().trim().min(1).max(200);
const diagramSourceSchema = z.string().min(1).max(MAX_DIAGRAM_BYTES);
const diagramFormatSchema = z.enum(DIAGRAM_FORMATS).default("mermaid");
const diagramIdSchema = z.number().int().positive();

/** Create a diagram from title + source, then refresh the list. */
export async function createDiagramAction(input: {
  title: string;
  source: string;
  format?: string;
}): Promise<number> {
  await requireAdmin();
  const row = await createDiagram({
    title: diagramTitleSchema.parse(input.title),
    source: diagramSourceSchema.parse(input.source),
    format: diagramFormatSchema.parse(input.format),
  });
  revalidatePath("/diagrams");
  return row.id;
}

/** Update a diagram's title/source, then refresh the list. */
export async function updateDiagramAction(
  id: number,
  patch: { title: string; source: string },
): Promise<void> {
  await requireAdmin();
  await updateDiagram(diagramIdSchema.parse(id), {
    title: diagramTitleSchema.parse(patch.title),
    source: diagramSourceSchema.parse(patch.source),
  });
  revalidatePath("/diagrams");
}

/** Rename a diagram (title only), then refresh the list. */
export async function renameDiagramAction(
  id: number,
  title: string,
): Promise<void> {
  await requireAdmin();
  await renameDiagram(diagramIdSchema.parse(id), diagramTitleSchema.parse(title));
  revalidatePath("/diagrams");
}

/** Soft-delete (archive) a diagram, then refresh the list. */
export async function deleteDiagramAction(id: number): Promise<void> {
  await requireAdmin();
  await archiveDiagram(diagramIdSchema.parse(id));
  revalidatePath("/diagrams");
}

/** Restore a soft-deleted diagram, then refresh the list. */
export async function restoreDiagramAction(id: number): Promise<void> {
  await requireAdmin();
  await restoreDiagram(diagramIdSchema.parse(id));
  revalidatePath("/diagrams");
}

/** Permanently delete a diagram, then refresh the list. */
export async function purgeDiagramAction(id: number): Promise<void> {
  await requireAdmin();
  await purgeDiagram(diagramIdSchema.parse(id));
  revalidatePath("/diagrams");
}

/** Duplicate an agent/pipeline to a new slug, then refresh the page. */
export async function duplicateAgentAction(
  kind: AgentKind,
  fromSlug: string,
  toSlug: string,
): Promise<void> {
  await requireAdmin();
  await duplicateAgentSource(
    kindSchema.parse(kind),
    agentSlugSchema.parse(fromSlug),
    agentSlugSchema.parse(toSlug),
  );
  revalidatePath("/agents");
}
