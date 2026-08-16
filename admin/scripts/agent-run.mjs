// Detached orchestrator for markdown-defined agents & pipelines.
//
// Spawned (detached, own session) by src/lib/agent-runner.ts with a single arg:
// the path to a JSON spec file. It runs each step as a headless `claude -p`
// call, threading an *inclusive* (cumulative) context between pipeline steps —
// exactly the model documented in /opt/project/agents/README.md.
//
// Alongside the human-readable log it maintains a structured PROGRESS file
// (<slug>.progress.json) that the admin's run console polls to show which agent
// is currently working. Shape mirrors src/lib/agent-run-types.ts.
//
// Plain Node ESM on purpose: this process must outlive the admin `next dev`
// server (and its restarts), so it can't share the app's TS runtime. It only
// depends on node built-ins + the `claude` CLI on PATH.
//
// Spec file shape (written by agent-runner.ts):
//   { kind, slug, agentsRoot, inputs, steps: [{agent,label}],
//     logPath, progressPath, claudeBin, readOnlyTools: string[] }

import { spawn } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Minimal agent-frontmatter parsing — a deliberate, small port of
// src/lib/agents.ts so this standalone script stays dependency-free.
// ---------------------------------------------------------------------------

function splitFrontmatter(raw) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return { fm: "", body: raw.trim() };
  return { fm: m[1], body: m[2].trim() };
}

function stripComment(value) {
  const hash = value.indexOf("#");
  return (hash === -1 ? value : value.slice(0, hash)).trim();
}

function parseInlineList(value) {
  const v = stripComment(value);
  if (!v.startsWith("[")) return v ? [v] : [];
  return v
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseScalars(fm) {
  const out = new Map();
  for (const line of fm.split("\n")) {
    if (!line.trim() || line.startsWith(" ") || line.startsWith("-")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (val) out.set(key, val);
  }
  return out;
}

function parseAgent(slug, raw) {
  const { fm, body } = splitFrontmatter(raw);
  const s = parseScalars(fm);
  return {
    slug,
    model: s.get("model") ?? null,
    tools: s.has("tools") ? parseInlineList(s.get("tools")) : null,
    outputs: s.has("outputs") ? parseInlineList(s.get("outputs")) : [],
    body,
  };
}

async function loadAgent(agentsRoot, slug) {
  const raw = await fs.readFile(path.join(agentsRoot, `${slug}.md`), "utf8");
  return parseAgent(slug, raw);
}

function interpolate(body, context) {
  return body.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) =>
    context[key] != null ? String(context[key]) : "",
  );
}

// ---------------------------------------------------------------------------
// Progress file — written atomically (tmp + rename) so a polling reader never
// sees a half-written JSON document.
// ---------------------------------------------------------------------------

function makeProgress(spec) {
  return {
    runId: spec.runId,
    kind: spec.kind,
    slug: spec.slug,
    name: spec.name,
    logFile: spec.logFile,
    state: "starting",
    inputs: spec.inputs,
    steps: spec.steps.map((s, i) => ({
      index: i,
      agent: s.agent,
      label: s.label,
      state: "pending",
      startedAt: null,
      endedAt: null,
    })),
    currentStep: null,
    startedAt: null,
    endedAt: null,
    error: null,
  };
}

async function writeProgress(progressPath, progress) {
  const tmp = `${progressPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(progress, null, 2));
  await fs.rename(tmp, progressPath);
}

// ---------------------------------------------------------------------------
// Run one agent as a headless `claude -p` call. Uses stream-json so we can log
// each TOOL INVOCATION (WebSearch, Read, Write, the browser MCP, …) as it
// happens, interleaved with the assistant's text — then returns the final text
// for the pipeline's cumulative context. The console tails the log live.
// ---------------------------------------------------------------------------

/** Salient key of a tool's input, one line, for the log. */
function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return "";
  const keys = [
    "query", "url", "file_path", "path", "command",
    "pattern", "selector", "prompt", "text",
  ];
  let val;
  for (const k of keys) {
    if (typeof input[k] === "string" && input[k]) {
      val = input[k];
      break;
    }
  }
  if (val == null) {
    try {
      val = JSON.stringify(input);
    } catch {
      val = String(input);
    }
  }
  val = String(val).replace(/\s+/g, " ").trim();
  return val.length > 140 ? `${val.slice(0, 137)}…` : val;
}

/** Flatten a tool_result `content` (string | array of blocks) to text. */
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === "string" ? b : (b.text ?? ""))).join("");
  }
  return "";
}

function runClaude(spec, agent, prompt, log) {
  const tools = agent.tools ?? spec.readOnlyTools;
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--allowedTools", tools.join(","),
  ];
  if (agent.model) args.push("--model", agent.model);

  log.write(
    `\n$ claude -p <prompt> --allowedTools "${tools.join(",")}"` +
      `${agent.model ? ` --model ${agent.model}` : ""}\n`,
  );

  return new Promise((resolve, reject) => {
    const child = spawn(spec.claudeBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let buf = "";
    let finalText = "";
    let lastText = "";
    const toolNames = new Map(); // tool_use_id -> tool name

    const handleEvent = (ev) => {
      if (!ev || typeof ev !== "object") return;
      if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
        for (const b of ev.message.content) {
          if (b.type === "tool_use") {
            toolNames.set(b.id, b.name);
            const sum = summarizeToolInput(b.input);
            log.write(`  ↳ ${b.name}${sum ? `(${sum})` : ""}\n`);
          } else if (b.type === "text" && b.text) {
            lastText = b.text;
            log.write(`${b.text}\n`);
          }
          // "thinking" blocks are intentionally not logged.
        }
      } else if (ev.type === "user" && Array.isArray(ev.message?.content)) {
        for (const b of ev.message.content) {
          if (b.type === "tool_result" && b.is_error) {
            const name = toolNames.get(b.tool_use_id) ?? "tool";
            const txt = toolResultText(b.content).replace(/\s+/g, " ").trim();
            log.write(
              `  ✗ ${name} error: ${txt.length > 200 ? `${txt.slice(0, 197)}…` : txt}\n`,
            );
          }
        }
      } else if (ev.type === "result") {
        if (typeof ev.result === "string") finalText = ev.result;
        for (const d of ev.permission_denials ?? []) {
          log.write(`  ⚠ permission denied: ${d.tool_name ?? "tool"}\n`);
        }
      }
    };

    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          /* not a JSON event line — ignore */
        }
      }
    });
    child.stderr.on("data", (d) => log.write(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (buf.trim()) {
        try {
          handleEvent(JSON.parse(buf));
        } catch {
          /* ignore trailing partial */
        }
      }
      if (code === 0) resolve((finalText || lastText).trim());
      else reject(new Error(`claude exited with code ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const specPath = process.argv[2];
  if (!specPath) throw new Error("usage: agent-run.mjs <spec.json>");
  const spec = JSON.parse(await fs.readFile(specPath, "utf8"));

  const log = createWriteStream(spec.logPath, { flags: "a" });
  const stamp = () => new Date().toISOString();
  const done = (msg) =>
    new Promise((r) => log.write(`\n[agent-run ${stamp()}] ${msg}\n`, r));

  const progress = makeProgress(spec);
  const title =
    spec.kind === "pipeline"
      ? `pipeline "${spec.slug}" (${spec.steps.length} steps)`
      : `agent "${spec.slug}"`;

  progress.state = "running";
  progress.startedAt = stamp();
  await writeProgress(spec.progressPath, progress);

  log.write(
    `\n[agent-run ${stamp()}] starting ${title}\n` +
      `  inputs: ${JSON.stringify(spec.inputs)}\n`,
  );

  const context = { ...spec.inputs };
  try {
    for (let i = 0; i < spec.steps.length; i++) {
      const step = progress.steps[i];
      progress.currentStep = i;
      step.state = "running";
      step.startedAt = stamp();
      await writeProgress(spec.progressPath, progress);

      log.write(
        `\n[agent-run ${stamp()}] step ${i + 1}/${spec.steps.length}: ${step.label}\n`,
      );

      const agent = await loadAgent(spec.agentsRoot, step.agent);
      const prompt = interpolate(agent.body, context);
      const result = await runClaude(spec, agent, prompt, log);

      // Inclusive context: publish this agent's result under each of its
      // declared outputs (or under its slug if it declares none) so later
      // steps can reference it via {{name}}.
      const keys = agent.outputs.length ? agent.outputs : [agent.slug];
      for (const k of keys) context[k] = result;

      step.state = "done";
      step.endedAt = stamp();
      await writeProgress(spec.progressPath, progress);
    }

    progress.state = "done";
    progress.currentStep = null;
    progress.endedAt = stamp();
    await writeProgress(spec.progressPath, progress);
    await done(`done — ${title}`);
    log.end();
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const cur = progress.currentStep != null ? progress.steps[progress.currentStep] : null;
    if (cur) {
      cur.state = "failed";
      cur.endedAt = stamp();
    }
    progress.state = "failed";
    progress.error = msg;
    progress.endedAt = stamp();
    await writeProgress(spec.progressPath, progress).catch(() => {});
    await done(`FAILED — ${msg}`);
    log.end();
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[agent-run] fatal:", err);
  process.exit(1);
});
