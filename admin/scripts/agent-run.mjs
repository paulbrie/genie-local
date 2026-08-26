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

function parseIntScalar(v) {
  if (v == null) return null;
  const n = parseInt(stripComment(v), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const PERMISSION_MODES = ["default", "plan", "acceptEdits", "bypassPermissions"];

function parseAgent(slug, raw) {
  const { fm, body } = splitFrontmatter(raw);
  const s = parseScalars(fm);
  const pm = s.get("permissionMode");
  return {
    slug,
    model: s.get("model") ?? null,
    tools: s.has("tools") ? parseInlineList(s.get("tools")) : null,
    outputs: s.has("outputs") ? parseInlineList(s.get("outputs")) : [],
    body,
    maxTurns: parseIntScalar(s.get("maxTurns")),
    timeoutSec: parseIntScalar(s.get("timeout")),
    permissionMode: pm && PERMISSION_MODES.includes(stripComment(pm)) ? stripComment(pm) : null,
    cwd: s.has("cwd") ? stripComment(s.get("cwd")) || null : null,
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

/** Pull the usage/cost/timing fields out of a stream-json `result` event. */
function usageFromResult(ev) {
  const u = ev.usage ?? {};
  const inTok =
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  return {
    costUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : null,
    inputTokens: Number.isFinite(inTok) && inTok > 0 ? inTok : (u.input_tokens ?? null),
    outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : null,
    turns: typeof ev.num_turns === "number" ? ev.num_turns : null,
    durationMs: typeof ev.duration_ms === "number" ? ev.duration_ms : null,
  };
}

/**
 * Run one agent as a headless `claude -p` call under the effective config
 * (`cfg`: tools/model/maxTurns/permissionMode/cwd/timeoutSec). Streams each tool
 * invocation to the log, records write targets via `onArtifact`, enforces a
 * wall-clock timeout, and resolves `{ text, usage }`.
 */
function runClaude(spec, cfg, prompt, log, onArtifact) {
  const tools = cfg.tools ?? spec.readOnlyTools;
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--allowedTools", tools.join(","),
  ];
  if (cfg.model) args.push("--model", cfg.model);
  if (cfg.maxTurns) args.push("--max-turns", String(cfg.maxTurns));
  if (cfg.permissionMode && cfg.permissionMode !== "default")
    args.push("--permission-mode", cfg.permissionMode);

  log.write(
    `\n$ claude -p <prompt> --allowedTools "${tools.join(",")}"` +
      `${cfg.model ? ` --model ${cfg.model}` : ""}` +
      `${cfg.maxTurns ? ` --max-turns ${cfg.maxTurns}` : ""}` +
      `${cfg.permissionMode && cfg.permissionMode !== "default" ? ` --permission-mode ${cfg.permissionMode}` : ""}` +
      `${cfg.cwd ? ` (cwd: ${cfg.cwd})` : ""}` +
      `${cfg.timeoutSec ? ` [timeout ${cfg.timeoutSec}s]` : ""}\n`,
  );

  return new Promise((resolve, reject) => {
    const child = spawn(spec.claudeBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
      cwd: cfg.cwd || undefined,
    });

    let buf = "";
    let finalText = "";
    let lastText = "";
    let usage = null;
    let settled = false;
    const toolNames = new Map(); // tool_use_id -> tool name

    // Wall-clock timeout: SIGTERM, then SIGKILL if it lingers.
    let timer = null;
    let timedOut = false;
    if (cfg.timeoutSec) {
      timer = setTimeout(() => {
        timedOut = true;
        log.write(`\n  ⏱ timeout after ${cfg.timeoutSec}s — terminating\n`);
        try { child.kill("SIGTERM"); } catch { /* gone */ }
        setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 5000);
      }, cfg.timeoutSec * 1000);
    }
    const clearTimer = () => { if (timer) clearTimeout(timer); };

    const handleEvent = (ev) => {
      if (!ev || typeof ev !== "object") return;
      if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
        for (const b of ev.message.content) {
          if (b.type === "tool_use") {
            toolNames.set(b.id, b.name);
            const sum = summarizeToolInput(b.input);
            log.write(`  ↳ ${b.name}${sum ? `(${sum})` : ""}\n`);
            // Record files a run creates/edits so the console can surface them.
            if ((b.name === "Write" || b.name === "Edit" || b.name === "NotebookEdit") &&
                b.input && typeof b.input.file_path === "string") {
              onArtifact?.(b.input.file_path);
            }
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
        usage = usageFromResult(ev);
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
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimer();
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimer();
      if (buf.trim()) {
        try {
          handleEvent(JSON.parse(buf));
        } catch {
          /* ignore trailing partial */
        }
      }
      if (timedOut) reject(new Error(`timed out after ${cfg.timeoutSec}s`));
      else if (code === 0) resolve({ text: (finalText || lastText).trim(), usage });
      else reject(new Error(`claude exited with code ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Concurrency semaphore — atomic-mkdir slot dirs under spec.slotsDir. At most
// spec.maxConcurrent runs hold a slot (execute steps) at once; the rest wait in
// the "queued" state. A slot held by a dead pid is reclaimed (crash-safe).
// ---------------------------------------------------------------------------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

async function tryAcquireSlot(spec) {
  await fs.mkdir(spec.slotsDir, { recursive: true });
  for (let i = 0; i < spec.maxConcurrent; i++) {
    const slot = path.join(spec.slotsDir, `slot-${i}`);
    try {
      await fs.mkdir(slot); // atomic create — throws if another run holds it
      await fs.writeFile(path.join(slot, "pid"), String(process.pid));
      return slot;
    } catch {
      try {
        const pid = parseInt(await fs.readFile(path.join(slot, "pid"), "utf8"), 10);
        if (Number.isInteger(pid) && !pidAlive(pid)) {
          await fs.rm(slot, { recursive: true, force: true });
          i--; // reclaim this stale slot on the next iteration
        }
      } catch {
        /* pid not written yet — treat as held, move on */
      }
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Block until a slot is free, keeping the run in "queued" state meanwhile. */
async function acquireSlot(spec, progress, log) {
  let slot = await tryAcquireSlot(spec);
  if (slot) return slot;
  progress.state = "queued";
  await writeProgress(spec.progressPath, progress);
  log.write(
    `\n[agent-run] all ${spec.maxConcurrent} run slots busy — queued…\n`,
  );
  while (!slot) {
    await sleep(1500);
    slot = await tryAcquireSlot(spec);
  }
  return slot;
}

/** Effective per-step config: dialog overrides > agent frontmatter > defaults. */
function resolveStepConfig(spec, agent) {
  const o = spec.config || {};
  const tools = agent.tools ?? spec.readOnlyTools;
  const canWrite = tools.some(
    (t) => t === "Write" || t === "Edit" || t === "NotebookEdit" || t === "Bash",
  );
  let cwd = o.cwd ?? agent.cwd ?? null;
  // Give write-enabled steps a predictable scratch dir instead of the CWD the
  // admin happened to spawn from, unless one was set explicitly.
  if (!cwd && canWrite) cwd = spec.scratchCwd;
  return {
    tools,
    model: agent.model,
    maxTurns: o.maxTurns ?? agent.maxTurns ?? null,
    permissionMode: o.permissionMode ?? agent.permissionMode ?? null,
    timeoutSec: o.timeoutSec ?? agent.timeoutSec ?? spec.defaults?.timeoutSec ?? null,
    cwd,
  };
}

/** Add two usage records field-by-field (nulls ignored). */
function addUsage(acc, u) {
  if (!u) return acc;
  const base = acc ?? { costUsd: null, inputTokens: null, outputTokens: null, turns: null, durationMs: null };
  const add = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
  return {
    costUsd: add(base.costUsd, u.costUsd),
    inputTokens: add(base.inputTokens, u.inputTokens),
    outputTokens: add(base.outputTokens, u.outputTokens),
    turns: add(base.turns, u.turns),
    durationMs: add(base.durationMs, u.durationMs),
  };
}

/** Best-effort completion webhook (never throws into the run). */
async function notify(spec, progress, log) {
  if (!spec.notifyWebhook || typeof fetch !== "function") return;
  try {
    await fetch(spec.notifyWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: progress.runId,
        name: progress.name,
        kind: progress.kind,
        slug: progress.slug,
        state: progress.state,
        error: progress.error,
        usage: progress.usage,
        artifacts: progress.artifacts,
      }),
    });
  } catch (e) {
    log.write(`\n[agent-run] notify failed: ${e?.message ?? e}\n`);
  }
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
  progress.config = spec.config ?? {};
  progress.usage = null;
  progress.artifacts = [];
  const title =
    spec.kind === "pipeline"
      ? `pipeline "${spec.slug}" (${spec.steps.length} steps)`
      : `agent "${spec.slug}"`;

  const artifacts = new Set();
  const recordArtifact = (p) => {
    if (p && !artifacts.has(p)) {
      artifacts.add(p);
      progress.artifacts = [...artifacts];
    }
  };

  let slot = null;
  try {
    // Preflight: every referenced agent file must exist before we take a slot,
    // so a typo'd pipeline step fails instantly instead of after queueing.
    for (const s of spec.steps) {
      try {
        await fs.access(path.join(spec.agentsRoot, `${s.agent}.md`));
      } catch {
        throw new Error(`agent "${s.agent}" not found in ${spec.agentsRoot}`);
      }
    }

    // Acquire a concurrency slot (may park the run in "queued" for a while).
    slot = await acquireSlot(spec, progress, log);

    progress.state = "running";
    progress.startedAt = progress.startedAt ?? stamp();
    await writeProgress(spec.progressPath, progress);

    log.write(
      `\n[agent-run ${stamp()}] starting ${title}\n` +
        `  inputs: ${JSON.stringify(spec.inputs)}\n`,
    );

    const context = { ...spec.inputs };
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
      const cfg = resolveStepConfig(spec, agent);
      if (cfg.cwd) await fs.mkdir(cfg.cwd, { recursive: true }).catch(() => {});
      const prompt = interpolate(agent.body, context);
      const { text: result, usage } = await runClaude(
        spec, cfg, prompt, log, recordArtifact,
      );

      step.usage = usage ?? null;
      progress.usage = addUsage(progress.usage, usage);
      if (usage) {
        log.write(
          `  · usage: ${usage.turns ?? "?"} turns` +
            `${usage.costUsd != null ? `, $${usage.costUsd.toFixed(4)}` : ""}` +
            `${usage.outputTokens != null ? `, ${usage.outputTokens} out-tok` : ""}\n`,
        );
      }

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
    await notify(spec, progress, log);
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
    await notify(spec, progress, log);
    log.end();
    process.exitCode = 1;
  } finally {
    // Always release the concurrency slot so a queued run can proceed.
    if (slot) await fs.rm(slot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error("[agent-run] fatal:", err);
  process.exit(1);
});
