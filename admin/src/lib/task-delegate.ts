import "server-only";

import path from "node:path";

import { listTerminals, sendKey, sendText, type TermStatus } from "@/lib/terminals";

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
};

const PROJECTS_ROOT = path.resolve(process.env.PROJECTS_ROOT ?? "/opt/project/projects");

/** Live Claude terminals, this project's first, then the rest by name. */
export async function delegateTargets(slug: string): Promise<DelegateTarget[]> {
  const projectDir = path.join(PROJECTS_ROOT, slug);
  return (await listTerminals())
    .filter((t) => t.status.startsWith("claude-") && !t.dead)
    .map((t) => ({
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
    }))
    .sort((a, b) => Number(b.inProject) - Number(a.inProject) || a.name.localeCompare(b.name));
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
): string {
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  const text = oneLine(body);
  const quoted =
    text.length > COMMENT_IN_BRIEF ? `${text.slice(0, COMMENT_IN_BRIEF)}… (cut: read it whole on the ticket)` : text;
  return [
    `New comment from the user on ticket #${task.id} of project "${slug}" ("${oneLine(task.title)}"), which is assigned to you: "${quoted}".`,
    `Read the thread with the local-genie MCP (list_task_comments, project "${slug}", id ${task.id}) and reply on the ticket with add_task_comment.`,
    ...(reopened
      ? [`The ticket was done: it's back in progress now. When you've handled this, set it to done again with the commit sha (set_task_status).`]
      : []),
  ].join(" ");
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
