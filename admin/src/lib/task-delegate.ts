import "server-only";

import path from "node:path";

import { delegatedTickets } from "@/lib/data";
import { createTerminalRunning, listTerminals, sendKey, sendText, type TermStatus } from "@/lib/terminals";

/** A ticket as the delegation picker mentions it. */
export type TicketRef = { id: number; title: string; status: string; project: string };

/** A Claude terminal a task can be delegated to, as the picker shows it. */
export type DelegateTarget = {
  name: string;
  status: TermStatus;
  tokens: number | null;
  cwd: string;
  /** In this project: its directory is inside it, or its name says so. */
  inProject: boolean;
  /** Typing into it now is safe (idle, or working: the brief waits its turn). */
  canSend: boolean;
  /** The in-progress ticket it's assigned (any project): it isn't offered for another one. */
  busyWith: TicketRef | null;
  /** The ticket it was assigned most recently (any status, any project). */
  last: TicketRef | null;
};

const PROJECTS_ROOT = path.resolve(process.env.PROJECTS_ROOT ?? "/opt/project/projects");

/**
 * Live Claude terminals: free ones first (this project's first), then those
 * already on an in-progress ticket; each with that ticket and its last one.
 */
export async function delegateTargets(slug: string): Promise<DelegateTarget[]> {
  const projectDir = path.join(PROJECTS_ROOT, slug);
  const [terminals, tickets] = await Promise.all([listTerminals(), delegatedTickets()]);
  const ref = (t: (typeof tickets)[number]): TicketRef => ({
    id: t.id,
    title: t.title,
    status: t.status,
    project: t.project,
  });
  return terminals
    .filter((t) => t.status.startsWith("claude-") && !t.dead)
    .map((t) => {
      // newest delegation first (delegatedTickets' order)
      const mine = tickets.filter((x) => x.assignee === t.name);
      const busy = mine.find((x) => x.status === "in_progress");
      return {
        name: t.name,
        status: t.status,
        tokens: t.tokens?.total ?? null,
        cwd: t.cwd,
        // tmux only knows the shell's directory, which can sit elsewhere (e.g.
        // "Alex- aCCCess" in /opt/project/admin), so a name naming the project counts too.
        inProject:
          t.cwd === projectDir ||
          t.cwd.startsWith(projectDir + path.sep) ||
          t.name.toLowerCase().includes(slug.toLowerCase()),
        // At a permission / choice prompt, typed text could pick an option.
        canSend: t.status !== "claude-input",
        busyWith: busy ? ref(busy) : null,
        last: mine[0] ? ref(mine[0]) : null,
      };
    })
    .sort(
      (a, b) =>
        Number(!!a.busyWith) - Number(!!b.busyWith) ||
        Number(b.inProject) - Number(a.inProject) ||
        a.name.localeCompare(b.name),
    );
}

/**
 * The one-line brief typed into the terminal. One line on purpose: tmux
 * send-keys submits at every newline, so a multi-line prompt would arrive in
 * pieces. The ticket itself (description, files, comments) is read through the
 * local-genie MCP.
 */
export function delegateBrief(
  slug: string,
  task: { id: number; title: string },
  note: string | null,
): string {
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  const parts = [
    `Ticket #${task.id} of project "${slug}" is assigned to you: "${oneLine(task.title)}".`,
    `Read it with the local-genie MCP: list_tasks (project "${slug}"), list_task_comments and list_task_attachments (id ${task.id}).`,
    `Move it to in_progress when you start (set_task_status), comment on the ticket with questions and progress (add_task_comment), and when it's finished set it to done with the commit sha.`,
  ];
  if (note) parts.push(`Note: ${oneLine(note)}`);
  return parts.join(" ");
}

// A comment beyond this is cut in the brief: the agent reads it whole on the ticket.
const COMMENT_IN_BRIEF = 1500;

/**
 * The one-line note typed into the assignee's terminal when the user comments
 * on its ticket: the comment itself, and how to reply on the ticket.
 */
export function commentBrief(
  slug: string,
  task: { id: number; title: string },
  body: string,
  reopened = false,
  /** files that came with the comment (images, logs…) */
  files = 0,
): string {
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  const text = oneLine(body);
  const quoted =
    text.length > COMMENT_IN_BRIEF ? `${text.slice(0, COMMENT_IN_BRIEF)}… (cut: read it whole on the ticket)` : text;
  return [
    `New comment from the user on ticket #${task.id} of project "${slug}" ("${oneLine(task.title)}"), which is assigned to you: "${quoted}".`,
    ...(files
      ? [`It comes with ${files} file${files === 1 ? "" : "s"} (e.g. screenshots): list_task_comments lists them with their paths; look at them.`]
      : []),
    `Read the thread with the local-genie MCP (list_task_comments, project "${slug}", id ${task.id}) and reply on the ticket with add_task_comment.`,
    ...(reopened
      ? [`The ticket was done: it's back in progress now. When you've handled this, set it to done again with the commit sha (set_task_status).`]
      : []),
  ].join(" ");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Start the terminal's Claude on a clean slate: type /clear, then wait until
 * it's back at an idle prompt. Only from idle: a /clear typed while Claude
 * works would land mid-task.
 */
export async function clearContext(terminal: string): Promise<void> {
  const target = (await listTerminals()).find((t) => t.name === terminal);
  if (!target || target.dead) throw new Error(`Terminal "${terminal}" is gone`);
  if (target.status !== "claude-idle") {
    throw new Error(
      target.status === "claude-working"
        ? `"${terminal}" is working: its context can only be cleared when it's idle`
        : target.status === "claude-input"
          ? `"${terminal}" is waiting on a prompt; answer it first`
          : target.status === "claude-background"
            ? `"${terminal}" has work running in the background: /clear could cut it off`
            : `"${terminal}" isn't running Claude`,
    );
  }
  await sendText(terminal, "/clear");
  await sendKey(terminal, "Enter");
  // /clear is quick; then make sure Claude is back at its prompt.
  await sleep(1200);
  const deadline = Date.now() + 8000;
  for (;;) {
    const now = (await listTerminals()).find((t) => t.name === terminal);
    if (now?.status === "claude-idle") return;
    if (Date.now() > deadline) throw new Error(`"${terminal}" didn't come back to its prompt after /clear`);
    await sleep(400);
  }
}

/** How a new agent's Claude starts: as the team's agents do (Opus, high effort, auto permissions). */
export const NEW_AGENT = { model: "opus", effort: "high", permissionMode: "auto" } as const;

/** A new agent for a ticket is named after it: "<project>-<ticket id>", e.g. "acccess-52". */
export const newAgentName = (slug: string, taskId: number) => `${slug}-${taskId}`;

/**
 * Start a new Claude agent in its own terminal (named `name`, both the tmux
 * session and Claude's -n), in `cwd`, with `brief` as its first prompt: it
 * starts on the ticket at once, no waiting for a ready prompt.
 */
export async function startAgent(name: string, cwd: string, brief: string): Promise<void> {
  // A leading "-" would be read as a claude option, not as the prompt.
  const prompt = brief.startsWith("-") ? ` ${brief}` : brief;
  await createTerminalRunning(name, (target) => [
    "new-session", "-d", "-s", target, "-x", "200", "-y", "50", "-c", cwd,
    "claude", "--model", NEW_AGENT.model, "--effort", NEW_AGENT.effort,
    "--permission-mode", NEW_AGENT.permissionMode, "-n", name, prompt,
    // the pane stays readable if claude exits; the wheel scrolls tmux's history
    ";", "set-option", "-w", "-t", target, "remain-on-exit", "on",
    ";", "set-option", "-t", target, "mouse", "on",
  ]);
}

/** Type the brief into the terminal and submit it. Throws if it can't take it now. */
export async function sendBrief(terminal: string, brief: string) {
  const target = (await listTerminals()).find((t) => t.name === terminal);
  if (!target || target.dead) throw new Error(`Terminal "${terminal}" is gone`);
  if (!target.status.startsWith("claude-")) {
    throw new Error(`"${terminal}" isn't running Claude`);
  }
  if (target.status === "claude-input") {
    throw new Error(`"${terminal}" is waiting on a prompt (permission or choice); answer it first`);
  }
  await sendText(terminal, brief);
  await sendKey(terminal, "Enter");
  return target.status;
}
