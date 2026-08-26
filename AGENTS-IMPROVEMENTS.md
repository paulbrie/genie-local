# Agents — missing features & improvements

A review of the **Agents** capability (markdown-defined agents/pipelines run
headlessly via `claude -p`). Most items below are now **implemented** ✅; the
remaining ones (a pipeline-execution-engine rewrite and a polling→SSE migration)
are called out as **deferred** with rationale.

## What already worked (baseline)

- [x] Markdown agents (frontmatter config + body as system prompt) and linear
      pipelines that thread a **cumulative context** between steps.
- [x] Visual form editor + raw editing, full CRUD, slug/path-traversal guards.
- [x] Detached run; per-run `.log` + `.progress.json`; persistent history; run
      dock; stop from the window.
- [x] Tool policy: `tools:` → `--allowedTools`; omitted ⇒ read-only set.

---

## 1. Safety & cost controls — ✅ done

- [x] **Per-run timeout & max-turns.** Frontmatter `timeout:` (seconds) and
      `maxTurns:`, plus a per-launch override in the Run dialog and a global
      default (`AGENT_DEFAULT_TIMEOUT_SEC`, 1800s). The orchestrator passes
      `--max-turns` and kills the child on wall-clock timeout (→ step `failed`).
- [x] **Concurrency limit / queue.** A filesystem semaphore
      (`AGENT_MAX_CONCURRENT`, default 3) parks extra runs in a new **`queued`**
      state until a slot frees; stale slots (dead pids) are reclaimed.
- [x] **Working-directory confinement.** Frontmatter/override `cwd:`; write-
      enabled steps default to a per-run **scratch dir** (`<runId>.cwd`) instead
      of the admin's CWD.
- [x] **Permission-mode selector.** `permissionMode:` frontmatter + Run-dialog
      select → `--permission-mode` (plan / acceptEdits / bypassPermissions).

## 2. Run history & observability — ✅ mostly done

- [x] **Token/cost & duration metrics.** Parsed from each step's `result` event
      (cost, in/out tokens, turns, duration), aggregated per run, shown in the
      console (per-step + total) and history (cost).
- [x] **Re-run / retry from history.** One-click re-run (console + each history
      row) reusing the original spec's inputs/config.
- [x] **Filter + retention.** History filters by text and state, shows counts,
      has **Clear finished**, and auto-prunes runs older than
      `AGENT_RUNS_RETENTION_DAYS` (30) on read.
- [x] **Surface artifacts.** Files touched by `Write`/`Edit`/`NotebookEdit` are
      captured and listed in the run window.
- [~] **Per-step logs.** Per-step markers + per-step usage now show; a combined
      `.log` is still used (no per-step offset jump). *Partial.*
- [ ] **Live streaming (SSE).** *Deferred* — polling `progress.json` + tail
      works well; SSE is a sizeable refactor for marginal latency gains.

## 3. Pipelines: expressiveness

- [x] **Validate referenced agents.** The orchestrator preflights every step's
      agent file (fast `failed` on a typo); the editor still flags "(missing)".
- [~] **Input/output wiring.** Agents publish outputs into the cumulative
      context and bodies read them via `{{name}}` (works today); explicit
      per-step `with:` mapping is *not* added. *Partial.*
- [ ] **Parallel / fan-out**, **conditional / branching**, **loop-until.**
      *Deferred* — these require rewriting the linear orchestrator into a real
      execution engine; scoped as a dedicated follow-up.

## 4. Inputs & outputs

- [x] **Surface artifacts.** (see §2)
- [ ] **Typed inputs** (select/number/file/required) — *deferred*; still plain
      textareas.
- [ ] **Structured output / schema** — *deferred*.

## 5. Scheduling & automation

- [x] **Completion notifications.** On finish/failure the orchestrator POSTs a
      JSON summary (state, error, usage, artifacts) to `AGENT_RUN_NOTIFY_WEBHOOK`
      when set.
- [ ] **Scheduled runs (cron)** — *deferred* (would reuse the stats-cron pattern).
- [ ] **Trigger from events** — *deferred*.

## 6. Authoring UX

- [x] **Duplicate.** Copy an agent/pipeline to a new slug (renames `name:` to
      "… (copy)").
- [x] **Dry-run / prompt preview.** The Run dialog's **Preview** renders the
      exact prompt(s) that would be sent — no tokens spent (pipeline steps show
      unresolved `{{output}}` placeholders).
- [ ] **Definition diff / version history** — *deferred* (files are in git).
- [ ] **MCP/tool picker** — *deferred* (tool suggestion chips exist).

## 7. Correctness / hardening — ✅ done

- [x] **Input-size caps.** Inputs capped (50 KB each) server-side; prompt-
      injection surface documented in `agents/README.md`.
- [x] **Orphaned-run reconciliation.** A dead-but-"running"/"queued" run is
      persisted as `failed` on the next history read (survives reboots).
- [x] **`newRunId` collision + ordering.** Ids now include a per-process
      monotonic counter, so two launches in the same millisecond can't collide.
