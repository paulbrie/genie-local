"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

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
  deleteNote,
  deleteTask,
  getAppRunTarget,
  getProjectIdBySlug,
  reorderNotes,
  reorderTasks,
  setTaskDone,
  updateAppPort,
  updateNote,
  updateTask,
} from "@/lib/data";
import {
  type DeployStatus,
  deployStatus,
  startDeploy,
} from "@/lib/deploy";
import { applyNginx, type NginxApplyResult } from "@/lib/nginx";
import {
  restartApp,
  startApp,
  statusFor,
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
import { rescanProject, scanAndPersist } from "@/lib/scan";
import { readScripts } from "@/lib/signals";

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

export async function rescanAllAction() {
  await scanAndPersist();
  revalidatePath("/");
}

export async function rescanProjectAction(slug: string) {
  const parsed = slugSchema.parse(slug);
  await rescanProject(parsed);
  revalidatePath(`/projects/${parsed}`);
  revalidatePath("/");
}

export async function addNoteAction(slug: string, formData: FormData) {
  const id = await requireProjectId(slug);
  const body = z.string().trim().min(1).max(5000).parse(formData.get("body"));
  await addNote(id, body);
  revalidatePath(`/projects/${slug}`);
}

export async function updateNoteAction(
  slug: string,
  noteId: number,
  body: string,
) {
  const id = await requireProjectId(slug);
  const parsedNoteId = z.number().int().positive().parse(noteId);
  const parsedBody = z.string().trim().min(1).max(5000).parse(body);
  await updateNote(id, parsedNoteId, parsedBody);
  revalidatePath(`/projects/${slug}`);
}

export async function deleteNoteAction(slug: string, noteId: number) {
  const id = await requireProjectId(slug);
  const parsedNoteId = z.number().int().positive().parse(noteId);
  await deleteNote(id, parsedNoteId);
  revalidatePath(`/projects/${slug}`);
}

export async function reorderNotesAction(slug: string, orderedIds: number[]) {
  const id = await requireProjectId(slug);
  const ids = z.array(z.number().int().positive()).max(1000).parse(orderedIds);
  await reorderNotes(id, ids);
  revalidatePath(`/projects/${slug}`);
}

export async function addTaskAction(slug: string, formData: FormData) {
  const id = await requireProjectId(slug);
  const title = z.string().trim().min(1).max(500).parse(formData.get("title"));
  const rawDesc = formData.get("description");
  const description = z
    .string()
    .trim()
    .max(5000)
    .optional()
    .parse(typeof rawDesc === "string" && rawDesc.trim() ? rawDesc : undefined);
  await addTask(id, title, description ?? null);
  revalidatePath(`/projects/${slug}`);
}

export async function toggleTaskAction(
  slug: string,
  taskId: number,
  done: boolean,
) {
  const id = await requireProjectId(slug);
  const parsedTaskId = z.number().int().positive().parse(taskId);
  await setTaskDone(id, parsedTaskId, z.boolean().parse(done));
  revalidatePath(`/projects/${slug}`);
}

export async function updateTaskAction(
  slug: string,
  taskId: number,
  title: string,
  description: string | null,
) {
  const id = await requireProjectId(slug);
  const parsedTaskId = z.number().int().positive().parse(taskId);
  const parsedTitle = z.string().trim().min(1).max(500).parse(title);
  const trimmedDesc = typeof description === "string" ? description.trim() : "";
  const parsedDesc = z
    .string()
    .max(5000)
    .nullable()
    .parse(trimmedDesc ? trimmedDesc : null);
  await updateTask(id, parsedTaskId, {
    title: parsedTitle,
    description: parsedDesc,
  });
  revalidatePath(`/projects/${slug}`);
}

export async function deleteTaskAction(slug: string, taskId: number) {
  const id = await requireProjectId(slug);
  const parsedTaskId = z.number().int().positive().parse(taskId);
  await deleteTask(id, parsedTaskId);
  revalidatePath(`/projects/${slug}`);
}

export async function reorderTasksAction(slug: string, orderedIds: number[]) {
  const id = await requireProjectId(slug);
  const ids = z.array(z.number().int().positive()).max(1000).parse(orderedIds);
  await reorderTasks(id, ids);
  revalidatePath(`/projects/${slug}`);
}

/**
 * Update an app's port, then regenerate + reload Nginx so the change takes
 * effect immediately. Returns the Nginx apply result for UI feedback.
 */
export async function setAppPortAction(
  slug: string,
  appId: number,
  port: number | null,
): Promise<NginxApplyResult> {
  const projectId = await requireProjectId(slug);
  const parsedAppId = z.number().int().positive().parse(appId);
  const parsedPort =
    port === null
      ? null
      : z.number().int().min(1).max(65535).parse(port);

  await updateAppPort(projectId, parsedAppId, parsedPort);
  const result = await applyNginx();
  revalidatePath(`/projects/${slug}`);
  return result;
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
  const t = await requireAppTarget(slug, appId);
  const parsedScript = await requireScript(t, script);
  const status = await startApp({
    dir: t.path,
    projectSlug: t.projectSlug,
    appSlug: t.appSlug,
    port: t.port,
    script: parsedScript,
  });
  revalidatePath(`/projects/${slug}`);
  return status;
}

export async function stopAppAction(
  slug: string,
  appId: number,
  script: string,
): Promise<RunStatus> {
  const t = await requireAppTarget(slug, appId);
  // Stopping only needs a well-formed name (the unit may be a since-removed script).
  const parsedScript = scriptNameSchema.parse(script);
  const status = await stopApp(t.projectSlug, t.appSlug, parsedScript);
  revalidatePath(`/projects/${slug}`);
  return status;
}

export async function restartAppAction(
  slug: string,
  appId: number,
  script: string,
): Promise<RunStatus> {
  const t = await requireAppTarget(slug, appId);
  const parsedScript = await requireScript(t, script);
  const status = await restartApp({
    dir: t.path,
    projectSlug: t.projectSlug,
    appSlug: t.appSlug,
    port: t.port,
    script: parsedScript,
  });
  revalidatePath(`/projects/${slug}`);
  return status;
}

/** Poll one app+script's live run status (no revalidation). */
export async function appStatusAction(
  slug: string,
  appId: number,
  script: string,
): Promise<RunStatus> {
  const t = await requireAppTarget(slug, appId);
  const parsedScript = scriptNameSchema.parse(script);
  return statusFor(t.projectSlug, t.appSlug, parsedScript);
}

// ---------------------------------------------------------------------------
// Deploy — build the prod bundle from the current source and restart /admin.
// Dev (/admin-dev) start/stop lives on the Services page (plain systemctl).
// ---------------------------------------------------------------------------

/** Build + deploy prod (optionally running migrations first). Detached. */
export async function deployProdAction(
  migrate: boolean,
): Promise<{ ok: boolean; output?: string; error?: string }> {
  const result = await startDeploy(z.boolean().parse(migrate));
  revalidatePath("/services");
  return result;
}

/** Poll prod/dev service state + last deploy outcome (no revalidation). */
export async function deployStatusAction(): Promise<DeployStatus> {
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
  return stopRun(runIdSchema.parse(runId));
}

/** Poll a run's live status + structured step progress (for the run console). */
export async function runProgressByIdAction(
  runId: string,
): Promise<{ status: RunStatus; progress: RunProgress | null }> {
  const id = runIdSchema.parse(runId);
  const [status, progress] = await Promise.all([runStatus(id), readProgress(id)]);
  return { status, progress };
}

/** The run history + currently-active runs, newest first. */
export async function listRunsAction(): Promise<RunSummary[]> {
  return listRuns();
}

/** Delete a finished run's files (removes it from history). */
export async function deleteRunAction(runId: string): Promise<void> {
  await deleteRun(runIdSchema.parse(runId));
}

/** Delete every finished (not-running) run. Returns how many were removed. */
export async function clearFinishedRunsAction(): Promise<number> {
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
  return readAgentParsed(kindSchema.parse(kind), agentSlugSchema.parse(slug));
}

/** Create or update an agent/pipeline from structured fields, then refresh. */
export async function saveAgentDefAction(
  kind: AgentKind,
  slug: string,
  fields: AgentFields | PipelineFields,
  create: boolean,
): Promise<void> {
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
  await renameDiagram(diagramIdSchema.parse(id), diagramTitleSchema.parse(title));
  revalidatePath("/diagrams");
}

/** Soft-delete (archive) a diagram, then refresh the list. */
export async function deleteDiagramAction(id: number): Promise<void> {
  await archiveDiagram(diagramIdSchema.parse(id));
  revalidatePath("/diagrams");
}

/** Restore a soft-deleted diagram, then refresh the list. */
export async function restoreDiagramAction(id: number): Promise<void> {
  await restoreDiagram(diagramIdSchema.parse(id));
  revalidatePath("/diagrams");
}

/** Permanently delete a diagram, then refresh the list. */
export async function purgeDiagramAction(id: number): Promise<void> {
  await purgeDiagram(diagramIdSchema.parse(id));
  revalidatePath("/diagrams");
}

/** Duplicate an agent/pipeline to a new slug, then refresh the page. */
export async function duplicateAgentAction(
  kind: AgentKind,
  fromSlug: string,
  toSlug: string,
): Promise<void> {
  await duplicateAgentSource(
    kindSchema.parse(kind),
    agentSlugSchema.parse(fromSlug),
    agentSlugSchema.parse(toSlug),
  );
  revalidatePath("/agents");
}
