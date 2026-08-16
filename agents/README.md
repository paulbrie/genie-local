# Agents

This folder defines **agents** and **pipelines** as plain Markdown files, so they
live in version control, diff cleanly, and can be authored without touching code.

- **An agent** = one Markdown file at the top level of this folder
  (e.g. `researcher.md`). YAML frontmatter is its configuration; the Markdown
  body is its system prompt.
- **A pipeline** = one Markdown file under [`pipelines/`](./pipelines) that wires
  several agents together, feeding the work of each agent into the next.

The admin dashboard at **/admin/agents** is where you **create, edit, delete,
and run** these definitions. Authoring is **visual** — a form writes the file
for you (see *Editing in the admin* below), and the files stay the source of
truth. To **run** one, click **Run**, fill in the declared `inputs`, and the run
executes headlessly via `claude -p` as a detached process. It opens in a
**movable, resizable run window** (the same dock UX as the terminals) that
shows, live:

- a **step tracker** — which agent is currently working, which are done/failed
  (for a pipeline this is the ordered step list; a single agent is one step);
- the **tailing run log** — the streamed transcript, auto-scrolling: each **tool
  invocation** (`↳ WebSearch(…)`, `↳ Write(…)`, `↳ mcp__agent-browser__…`), any
  tool errors (`✗`) or permission denials (`⚠`), and the assistant's text.

The run window is mounted app-wide, so it **survives route changes and full page
reloads** (it re-attaches to the still-running process by its run id). Minimize
it into the bottom **Runs** bar, or close it — the run keeps going either way.

Every launch gets a unique run id with its own `<runId>.log` +
`<runId>.progress.json`, so the **Run history** section lists past runs (state,
timing, step counts). Open any entry to re-inspect its log/steps, jump to it on
the Logs page, or delete it. Run files persist in **`/opt/project/.run-logs`**
(override with `AGENT_RUNS_ROOT`) — a real directory, not `/tmp`, so history
**survives reboots**. The Logs page still lists/tails them under the
`run-logs/…` namespace. Runs survive an `admin.service` restart and can be
stopped from the run window.

**Tool policy when run from the dashboard.** An agent's `tools:` frontmatter is
passed verbatim as the run's `--allowedTools` allowlist. An agent that **omits**
`tools` does *not* get "all tools" here — it falls back to a safe **read-only**
set (`Read, Grep, Glob, WebSearch, WebFetch`) so a dashboard-triggered run can't
write to or shell on the server. Grant more only by listing it in `tools:`:

- **Writing files** — add `Write` and `Edit`. A run can then create/modify files
  anywhere the `genie` user can (the spawned `claude` runs as `genie`); it is
  *not* confined to a working directory. (The `writer` agent has these, so a
  pipeline can save its article to disk when asked.)
- **The agent browser** — add `mcp__agent-browser` to grant the whole
  browser-automation MCP (navigate, snapshot, click, screenshot; real Chromium,
  for JS-heavy or gated pages that `WebFetch` can't read). List a single tool
  like `mcp__agent-browser__agent_browser_open` to be narrower. (The `researcher`
  agent has this.) Other **MCP** tools work the same way — user-scoped servers
  (see `claude mcp list`) are available to runs; reference them as
  `mcp__<server>` or `mcp__<server>__<tool>`.

---

## Editing in the admin

Everything here can be authored **visually** at **/admin/agents** — no need to
hand-write Markdown:

- **New agent** / **New pipeline** create a file from a template; the **✎** on
  each card edits it; the **🗑** deletes it.
- The editor is a **form, not a text box**: the frontmatter becomes fields (name,
  description), a **model** dropdown, and chip pickers for `tools` / `inputs` /
  `outputs` (with suggestion toggles for the common tools). A pipeline's
  **steps** are an ordered list where each step is a **dropdown of existing
  agents** — so you can't reference one that doesn't exist — plus the optional
  `as` label and reorder controls. Only the body (system prompt / description)
  is a free-text area.
- On **Save** the file is written in exactly the format documented below, so a
  dashboard-authored file can't be malformed; invalid input is rejected. You can
  still edit the `.md` files directly — both round-trip cleanly.

The filename **slug** is chosen once at creation and isn't renamed from the
editor (pipelines reference agents by slug).

---

## 1. Agent file format

```markdown
---
name: researcher                     # unique slug (defaults to the file name)
description: Gathers sources on a topic and summarizes the findings
model: claude-opus-4-8               # optional; omit to inherit the caller's model
tools: [WebSearch, WebFetch, Read]   # allowlist; omit → read-only default (see tool policy)
inputs: [topic]                      # named values this agent expects
outputs: [findings]                  # named values this agent promises to return
---

You are a meticulous research assistant.

Given the topic **{{topic}}**, search the web, read the most authoritative
sources, and return a bullet-point summary. Every claim must cite its source URL.

Return your result as the `findings` output.
```

### Frontmatter fields

| Field         | Required | Meaning |
|---------------|----------|---------|
| `name`        | no       | Unique slug used to reference the agent from a pipeline. Defaults to the filename without `.md`. |
| `description` | yes      | One line shown in listings and used to decide relevance. |
| `model`       | no       | Model id (e.g. `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`, `claude-fable-5`). Omit to inherit the caller's model. |
| `tools`       | no       | Allowlist of tool names the agent may use. When omitted, a dashboard run falls back to a **read-only** default (see the tool policy above), not "all tools". |
| `inputs`      | no       | Names the agent reads from the shared context (see §3). |
| `outputs`     | no       | Names the agent writes back into the shared context. |

### Body = system prompt

Everything after the frontmatter is the agent's instructions. Use
`{{placeholder}}` to interpolate any value currently in the shared context —
a pipeline input, or an `output` produced by an earlier agent.

---

## 2. Pipeline file format

A pipeline chains agents. Each step names an agent; steps run top to bottom.

```markdown
---
name: blog-post
description: Turn a topic into a fact-checked, edited blog post
inputs: [topic]
steps:
  - agent: researcher      # produces `findings`
  - agent: writer          # reads `findings`, produces `draft`
  - agent: critic          # reads `draft`, produces `critique`
  - agent: writer          # reads `draft` + `critique`, produces `draft` (revised)
    as: reviser            # optional label so the same agent can appear twice
---

Research the topic, draft a post, critique it, then revise.
```

---

## 3. How piping works — *inclusive* (cumulative) context

Piping here is **inclusive**: a step does not receive only the previous step's
output — it receives **everything produced so far**. The runner keeps a single
shared context (a key→value map) that starts with the pipeline `inputs` and
grows as each agent writes its `outputs`:

```
context = { topic }                       # pipeline inputs
  ── researcher ──▶  context += { findings }
  ── writer     ──▶  context += { draft }            (can read topic + findings)
  ── critic     ──▶  context += { critique }         (can read topic + findings + draft)
  ── writer     ──▶  context.draft = <revised>       (can read the critique too)
```

So a later agent can reference **any** earlier value by name via `{{...}}`,
not just its immediate predecessor. When two steps declare the same output name,
the later value overwrites the earlier one (that's how "revise" works above).

This keeps agents small and composable: each one declares only the `inputs` it
needs and the `outputs` it contributes, and the runner handles the plumbing.

---

## 4. Conventions

- One agent per file; filename = slug (kebab-case).
- Keep `description` to a single line — it's the "recall" hook.
- Prefer many small single-purpose agents over one large agent.
- A pipeline should read like a sentence: *research → draft → critique → revise*.
