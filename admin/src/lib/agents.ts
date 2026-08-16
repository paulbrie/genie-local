import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";

import { PROJECTS_ROOT } from "./signals";

/**
 * Where the markdown agents live. Defaults to the `agents/` folder that sits
 * next to `projects/` under /opt/project. Override with AGENTS_ROOT.
 */
export const AGENTS_ROOT =
  process.env.AGENTS_ROOT ?? path.resolve(PROJECTS_ROOT, "..", "agents");

export type Agent = {
  slug: string;
  name: string;
  description: string;
  model: string | null;
  tools: string[] | null;
  inputs: string[];
  outputs: string[];
  body: string;
};

export type PipelineStep = {
  agent: string;
  as: string | null;
};

export type Pipeline = {
  slug: string;
  name: string;
  description: string;
  inputs: string[];
  steps: PipelineStep[];
  body: string;
};

/**
 * Split a markdown file into its YAML-ish frontmatter block and body. We only
 * support the small subset of YAML the agent/pipeline spec uses, so this hand
 * parser avoids adding a dependency.
 */
function splitFrontmatter(raw: string): { fm: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return { fm: "", body: raw.trim() };
  return { fm: m[1], body: m[2].trim() };
}

/** Strip a trailing `# comment` that isn't inside brackets. */
function stripComment(value: string): string {
  const hash = value.indexOf("#");
  return (hash === -1 ? value : value.slice(0, hash)).trim();
}

/** Parse `[a, b, c]` inline lists (empty/absent → []). */
function parseInlineList(value: string): string[] {
  const v = stripComment(value);
  if (!v.startsWith("[")) return v ? [v] : [];
  return v
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

type Scalars = Map<string, string>;

/** Parse simple `key: value` scalar lines (ignores nested block lists). */
function parseScalars(fm: string): Scalars {
  const out: Scalars = new Map();
  for (const line of fm.split("\n")) {
    if (!line.trim() || line.startsWith(" ") || line.startsWith("-")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    // Skip keys that introduce a block (value empty → handled elsewhere).
    if (val) out.set(key, val);
  }
  return out;
}

/**
 * Parse a pipeline's `steps:` block list of the shape:
 *   steps:
 *     - agent: researcher
 *     - agent: writer
 *       as: reviser
 */
function parseSteps(fm: string): PipelineStep[] {
  const lines = fm.split("\n");
  const start = lines.findIndex((l) => /^steps:\s*$/.test(l.trim()));
  if (start === -1) return [];
  const steps: PipelineStep[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() && !/^\s/.test(line)) break; // dedented → block ended
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("- ")) {
      const rest = stripComment(trimmed.slice(2));
      const [k, v] = splitKeyVal(rest);
      steps.push({ agent: k === "agent" ? v : rest, as: null });
    } else if (steps.length) {
      const [k, v] = splitKeyVal(stripComment(trimmed));
      if (k === "as") steps[steps.length - 1].as = v;
      else if (k === "agent") steps[steps.length - 1].agent = v;
    }
  }
  return steps;
}

function splitKeyVal(s: string): [string, string] {
  const idx = s.indexOf(":");
  if (idx === -1) return [s.trim(), ""];
  return [s.slice(0, idx).trim(), s.slice(idx + 1).trim()];
}

function parseAgent(slug: string, raw: string): Agent {
  const { fm, body } = splitFrontmatter(raw);
  const s = parseScalars(fm);
  return {
    slug,
    name: s.get("name") ?? slug,
    description: s.get("description") ?? "",
    model: s.get("model") ?? null,
    tools: s.has("tools") ? parseInlineList(s.get("tools")!) : null,
    inputs: s.has("inputs") ? parseInlineList(s.get("inputs")!) : [],
    outputs: s.has("outputs") ? parseInlineList(s.get("outputs")!) : [],
    body,
  };
}

function parsePipeline(slug: string, raw: string): Pipeline {
  const { fm, body } = splitFrontmatter(raw);
  const s = parseScalars(fm);
  return {
    slug,
    name: s.get("name") ?? slug,
    description: s.get("description") ?? "",
    inputs: s.has("inputs") ? parseInlineList(s.get("inputs")!) : [],
    steps: parseSteps(fm),
    body,
  };
}

async function readMarkdownDir(dir: string): Promise<{ slug: string; raw: string }[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const files = entries.filter((f) => f.endsWith(".md") && f !== "README.md");
  const out = await Promise.all(
    files.sort().map(async (f) => ({
      slug: f.replace(/\.md$/, ""),
      raw: await fs.readFile(path.join(dir, f), "utf8"),
    })),
  );
  return out;
}

export async function listAgents(): Promise<Agent[]> {
  const files = await readMarkdownDir(AGENTS_ROOT);
  return files.map((f) => parseAgent(f.slug, f.raw));
}

export async function listPipelines(): Promise<Pipeline[]> {
  const files = await readMarkdownDir(path.join(AGENTS_ROOT, "pipelines"));
  return files.map((f) => parsePipeline(f.slug, f.raw));
}

/** Raw contents of the agents folder's README.md, or null when it's absent. */
export async function readAgentsReadme(): Promise<string | null> {
  try {
    return await fs.readFile(path.join(AGENTS_ROOT, "README.md"), "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CRUD on the raw markdown files (used by the admin's agent editor). Agents are
// `<AGENTS_ROOT>/<slug>.md`; pipelines are `<AGENTS_ROOT>/pipelines/<slug>.md`.
// ---------------------------------------------------------------------------

export type AgentKind = "agent" | "pipeline";

/** Max size of a saved agent/pipeline file. */
export const MAX_AGENT_BYTES = 256 * 1024;

const PIPELINES_ROOT = path.join(AGENTS_ROOT, "pipelines");

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Validate a slug (kebab-case, no path separators, not the README). */
export function isValidAgentSlug(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug.length <= 64 &&
    SLUG_RE.test(slug) &&
    slug.toLowerCase() !== "readme"
  );
}

const rootFor = (kind: AgentKind) =>
  kind === "pipeline" ? PIPELINES_ROOT : AGENTS_ROOT;

/** Resolve a kind+slug to its .md path, rejecting bad slugs / traversal. */
function resolveAgentFile(kind: AgentKind, slug: string): string {
  if (!isValidAgentSlug(slug)) throw new Error(`Invalid slug: ${slug}`);
  const dir = path.resolve(rootFor(kind));
  const file = path.resolve(dir, `${slug}.md`);
  if (path.dirname(file) !== dir) throw new Error("Path escapes the agents root");
  return file;
}

/** Does a file already exist for this kind+slug? */
export async function agentSourceExists(
  kind: AgentKind,
  slug: string,
): Promise<boolean> {
  try {
    await fs.access(resolveAgentFile(kind, slug));
    return true;
  } catch {
    return false;
  }
}

/** Raw markdown for one agent/pipeline (throws if missing). */
export async function readAgentSource(
  kind: AgentKind,
  slug: string,
): Promise<string> {
  return fs.readFile(resolveAgentFile(kind, slug), "utf8");
}

/**
 * Create or overwrite an agent/pipeline file. `create` guards the two error
 * cases: creating over an existing file, or updating one that's gone.
 */
export async function saveAgentSource(
  kind: AgentKind,
  slug: string,
  content: string,
  opts: { create: boolean },
): Promise<void> {
  if (content.length > MAX_AGENT_BYTES) throw new Error("File too large");
  const file = resolveAgentFile(kind, slug);
  const exists = await agentSourceExists(kind, slug);
  if (opts.create && exists) {
    throw new Error(`A ${kind} named "${slug}" already exists`);
  }
  if (!opts.create && !exists) {
    throw new Error(`No ${kind} named "${slug}"`);
  }
  await fs.mkdir(rootFor(kind), { recursive: true });
  // Normalize to a trailing newline (how the existing files are stored).
  await fs.writeFile(file, content.endsWith("\n") ? content : `${content}\n`);
}

/** Delete an agent/pipeline file (throws if missing). */
export async function deleteAgentSource(
  kind: AgentKind,
  slug: string,
): Promise<void> {
  const file = resolveAgentFile(kind, slug);
  if (!(await agentSourceExists(kind, slug))) {
    throw new Error(`No ${kind} named "${slug}"`);
  }
  await fs.rm(file);
}

// ---------------------------------------------------------------------------
// Structured (form) editing: parse one file into fields, and serialize fields
// back into the exact markdown frontmatter format the parsers above expect.
// The admin's visual editor round-trips through these, so it can't produce an
// invalid file.
// ---------------------------------------------------------------------------

/** Editable fields of an agent (model/tools = null means "omit the line"). */
export type AgentFields = {
  name: string;
  description: string;
  model: string | null;
  tools: string[] | null;
  inputs: string[];
  outputs: string[];
  body: string;
};

/** Editable fields of a pipeline. */
export type PipelineFields = {
  name: string;
  description: string;
  inputs: string[];
  steps: { agent: string; as: string | null }[];
  body: string;
};

/** Parse one agent/pipeline file into its structured fields. */
export async function readAgentParsed(
  kind: AgentKind,
  slug: string,
): Promise<Agent | Pipeline> {
  const raw = await readAgentSource(kind, slug);
  return kind === "pipeline" ? parsePipeline(slug, raw) : parseAgent(slug, raw);
}

/** Collapse a scalar to a single trimmed line (frontmatter values are 1 line). */
const oneLine = (s: string) => s.replace(/\r?\n/g, " ").trim();

function serializeAgent(slug: string, f: AgentFields): string {
  const lines = ["---", `name: ${oneLine(f.name) || slug}`];
  lines.push(`description: ${oneLine(f.description)}`);
  if (f.model) lines.push(`model: ${oneLine(f.model)}`);
  if (f.tools && f.tools.length) lines.push(`tools: [${f.tools.join(", ")}]`);
  if (f.inputs.length) lines.push(`inputs: [${f.inputs.join(", ")}]`);
  if (f.outputs.length) lines.push(`outputs: [${f.outputs.join(", ")}]`);
  lines.push("---", "", f.body.trim(), "");
  return lines.join("\n");
}

function serializePipeline(slug: string, f: PipelineFields): string {
  const lines = ["---", `name: ${oneLine(f.name) || slug}`];
  lines.push(`description: ${oneLine(f.description)}`);
  if (f.inputs.length) lines.push(`inputs: [${f.inputs.join(", ")}]`);
  lines.push("steps:");
  for (const s of f.steps) {
    lines.push(`  - agent: ${s.agent}`);
    if (s.as) lines.push(`    as: ${s.as}`);
  }
  lines.push("---", "", f.body.trim(), "");
  return lines.join("\n");
}

/** Serialize structured fields to markdown and write the file. */
export async function writeAgentFields(
  kind: AgentKind,
  slug: string,
  fields: AgentFields | PipelineFields,
  opts: { create: boolean },
): Promise<void> {
  const md =
    kind === "pipeline"
      ? serializePipeline(slug, fields as PipelineFields)
      : serializeAgent(slug, fields as AgentFields);
  await saveAgentSource(kind, slug, md, opts);
}
