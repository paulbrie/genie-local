import "server-only";

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { projects } from "@/db/schema";
import { addTask, getProjectIdBySlug, getTask, getTasks, setTaskStatus } from "@/lib/data";
import { askAboutTerminals } from "@/lib/terminal-qa";
import { captureTerminal, listTerminals, sendKey, sendText, type Terminal } from "@/lib/terminals";

import {
  ACTION_KEY,
  ACTION_SHOW,
  HELP,
  alertMessage,
  detectAlerts,
  escapeSlack,
  keyFor,
  paneExcerpt,
  parseAllowed,
  parseChoices,
  parseCommand,
  parseReply,
  screenMessage,
  slackToPlain,
  statusText,
  tasksText,
  type AlertEvent,
  type Block,
  type ButtonValue,
  type Command,
  type WatchMem,
} from "./core";
import { SlackError, SocketMode, respond, slackApi, type Envelope } from "./socket";

/**
 * The admin's Slack bot: alerts when a Claude terminal finishes or waits on you,
 * replies in an alert's thread typed into that terminal, and `/genie` (or a DM)
 * commands for terminals and tasks. It runs inside the prod admin process
 * (src/instrumentation.ts), over Socket Mode, and only answers the Slack users
 * in SLACK_ALLOWED_USERS: typing into a terminal is as good as a shell here.
 *
 * Env (admin/.env.local):
 *   SLACK_BOT_TOKEN      xoxb-…  (Bot User OAuth Token)
 *   SLACK_APP_TOKEN      xapp-…  (App-Level Token with connections:write)
 *   SLACK_ALLOWED_USERS  Slack user ids, comma-separated
 *   SLACK_CHANNEL        channel id for alerts (the bot must be in it); unset = a DM to each allowed user
 *   SLACK_ALERTS         "on" (default) or "off"
 */

const POLL_MS = 3000;
/** A reply in a thread makes it the terminal's conversation: its next alert goes there for this long. */
const FOLLOW_UP_MS = 60 * 60_000;
const THREAD_TTL_MS = 14 * 24 * 60 * 60_000;
const MAX_THREADS = 3000;
const STATE_FILE = process.env.SLACK_STATE_FILE || "/opt/project/.slack/state.json";

type ThreadRef = { channel: string; terminal: string; at: number };
type State = {
  /** message ts → the terminal its thread talks to */
  threads: Record<string, ThreadRef>;
  muted: string[];
};

type Ctx = {
  user: string;
  channel: string;
  /** Where an answer goes: a thread's ts (alerts, DMs in a thread), or none for a top-level DM. */
  threadTs?: string;
  /** A slash command answers through its response_url, ephemerally, instead of posting. */
  responseUrl?: string;
};

/** `terminal`: the answer's thread talks to it; `follow`: and its next alert goes there too. */
type Answer = { text: string; blocks?: Block[]; terminal?: string; follow?: boolean };

const log = (msg: string) => console.log(`[slack] ${msg}`);

class Bot {
  private socket: SocketMode;
  private botUserId = "";
  private state: State = { threads: {}, muted: [] };
  private mem = new Map<string, WatchMem>();
  private polling = false;
  private seenEvents = new Map<string, number>();
  private toldUnknown = new Map<string, number>();
  private alertTargets: string[] = [];
  private followUp = new Map<string, { channel: string; ts: string; at: number }>();
  private timer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly token: string,
    appToken: string,
    private readonly allowed: Set<string>,
    private readonly channel: string | null,
    private readonly alertsOn: boolean,
    private readonly terminalsUrl: string | null,
  ) {
    this.socket = new SocketMode(appToken, (e) => void this.onEnvelope(e), log);
  }

  async start() {
    await this.load();
    const auth = await slackApi<{ user_id: string; team: string }>(this.token, "auth.test");
    this.botUserId = auth.user_id;
    log(`signed in to ${auth.team} as ${auth.user_id}; ${this.allowed.size} allowed user(s)`);
    if (this.alertsOn) this.alertTargets = await this.resolveTargets();
    this.socket.start();
    if (this.alertsOn) {
      this.timer = setInterval(() => void this.poll(), POLL_MS);
      this.timer.unref();
    }
  }

  stop() {
    this.socket.stop();
    if (this.timer) clearInterval(this.timer);
  }

  // ── State (threads → terminals, muted terminals), kept across restarts ──

  private async load() {
    try {
      const raw = JSON.parse(await readFile(STATE_FILE, "utf8")) as Partial<State>;
      this.state = { threads: raw.threads ?? {}, muted: raw.muted ?? [] };
    } catch {
      /* first run */
    }
  }

  private save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const now = Date.now();
      const entries = Object.entries(this.state.threads)
        .filter(([, t]) => now - t.at < THREAD_TTL_MS)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, MAX_THREADS);
      this.state.threads = Object.fromEntries(entries);
      const tmp = `${STATE_FILE}.tmp`;
      void mkdir(dirname(STATE_FILE), { recursive: true })
        .then(() => writeFile(tmp, JSON.stringify(this.state), { mode: 0o600 }))
        .then(() => rename(tmp, STATE_FILE))
        .catch((e) => log(`saving state: ${(e as Error).message}`));
    }, 1000);
    this.saveTimer.unref();
  }

  private remember(ts: string, channel: string, terminal: string) {
    this.state.threads[ts] = { channel, terminal, at: Date.now() };
    this.save();
  }

  private async resolveTargets(): Promise<string[]> {
    if (this.channel) return [this.channel];
    const out: string[] = [];
    for (const user of this.allowed) {
      try {
        const r = await slackApi<{ channel: { id: string } }>(this.token, "conversations.open", { users: user });
        out.push(r.channel.id);
      } catch (e) {
        log(`can't open a DM with ${user}: ${(e as Error).message}`);
      }
    }
    return out;
  }

  // ── Alerts ──

  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const list = await listTerminals().catch(() => [] as Terminal[]);
      const { mem, alerts } = detectAlerts(this.mem, list, Date.now());
      this.mem = mem;
      const muted = new Set(this.state.muted);
      for (const a of alerts) {
        if (!muted.has(a.name)) await this.alert(a.name, a.event).catch((e) => log(`alert ${a.name}: ${(e as Error).message}`));
      }
    } finally {
      this.polling = false;
    }
  }

  private async alert(name: string, event: AlertEvent) {
    const cap = await captureTerminal(name);
    const msg = alertMessage(
      name,
      event,
      paneExcerpt(cap.content, cap.status, event === "needs-input" ? 40 : 30),
      event === "needs-input" ? parseChoices(cap.content) : [],
      this.terminalsUrl ?? undefined,
    );
    // A terminal someone is talking to from a thread answers in that thread (and in the channel).
    const follow = this.followUp.get(name);
    if (follow && Date.now() - follow.at < FOLLOW_UP_MS) {
      await this.post(follow.channel, msg, name, follow.ts, true);
      return;
    }
    for (const channel of this.alertTargets) await this.post(channel, msg, name);
  }

  private async post(channel: string, msg: { text: string; blocks?: Block[] }, terminal?: string, threadTs?: string, broadcast = false) {
    const r = await slackApi<{ ts: string; channel: string }>(this.token, "chat.postMessage", {
      channel,
      text: msg.text,
      ...(msg.blocks ? { blocks: msg.blocks } : {}),
      ...(threadTs ? { thread_ts: threadTs, ...(broadcast ? { reply_broadcast: true } : {}) } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    // Replies to the message (or, in a thread, to the thread) talk to its terminal.
    if (terminal) this.remember(threadTs ?? r.ts, r.channel, terminal);
    return r;
  }

  // ── Incoming ──

  private isAllowed(user: string | undefined): user is string {
    return !!user && this.allowed.has(user);
  }

  /** Slack retries an event it thinks went unanswered: handle each once. */
  private firstTime(id: string | undefined): boolean {
    if (!id) return true;
    const now = Date.now();
    if (this.seenEvents.has(id)) return false;
    this.seenEvents.set(id, now);
    if (this.seenEvents.size > 500) {
      for (const [k, at] of this.seenEvents) if (now - at > 10 * 60_000) this.seenEvents.delete(k);
    }
    return true;
  }

  private async onEnvelope(e: Envelope) {
    try {
      if (e.type === "events_api") await this.onEvent(e.payload);
      else if (e.type === "slash_commands") await this.onSlash(e.payload);
      else if (e.type === "interactive") await this.onAction(e.payload);
    } catch (err) {
      log(`${e.type}: ${(err as Error).message}`);
    }
  }

  private async onEvent(payload: Record<string, unknown>) {
    if (!this.firstTime(payload.event_id as string | undefined)) return;
    const ev = payload.event as {
      type: string;
      subtype?: string;
      bot_id?: string;
      user?: string;
      text?: string;
      channel: string;
      channel_type?: string;
      ts: string;
      thread_ts?: string;
    };
    if (ev.type !== "message" || ev.subtype || ev.bot_id || !ev.user || ev.user === this.botUserId) return;
    const dm = ev.channel_type === "im";
    const raw = ev.text ?? "";
    const thread = ev.thread_ts ? this.state.threads[ev.thread_ts] : undefined;
    const mentioned = raw.includes(`<@${this.botUserId}>`);
    // In channels the bot only listens to its terminal threads and to messages that mention it.
    if (!dm && !thread && !mentioned) return;
    if (!this.isAllowed(ev.user)) {
      await this.tellUnknown(ev.user, ev.channel, ev.thread_ts ?? ev.ts);
      return;
    }
    const text = slackToPlain(raw, this.botUserId);
    // In a terminal's thread everything is typed into it, unless it @mentions the bot ("@genie show x").
    if (thread && !mentioned) {
      await this.reply(thread.terminal, text, ev.user, ev.channel, ev.thread_ts!, ev.ts);
      return;
    }
    const ctx: Ctx = { user: ev.user, channel: ev.channel, threadTs: ev.thread_ts ?? (dm ? undefined : ev.ts) };
    await this.answer(ctx, await this.run(parseCommand(text), ctx));
  }

  private async onSlash(p: Record<string, unknown>) {
    const user = p.user_id as string;
    const responseUrl = p.response_url as string;
    if (!this.isAllowed(user)) {
      await respond(responseUrl, { response_type: "ephemeral", text: unknownText(user) });
      return;
    }
    const ctx: Ctx = { user, channel: p.channel_id as string, responseUrl };
    const cmd = parseCommand(slackToPlain((p.text as string) ?? "", this.botUserId));
    if (cmd.kind === "ask") await respond(responseUrl, { response_type: "ephemeral", text: ":thinking_face: Looking at the terminals…" });
    await this.answer(ctx, await this.run(cmd, ctx));
  }

  private async onAction(p: Record<string, unknown>) {
    if (p.type !== "block_actions") return;
    const user = (p.user as { id: string }).id;
    const channel = (p.channel as { id: string } | undefined)?.id;
    const container = p.container as { message_ts?: string; thread_ts?: string } | undefined;
    const ts = container?.message_ts;
    const action = (p.actions as { action_id: string; value?: string }[])[0];
    if (!channel || !ts || !action?.value) return;
    if (!this.isAllowed(user)) {
      await this.tellUnknown(user, channel, ts);
      return;
    }
    let value: ButtonValue;
    try {
      value = JSON.parse(action.value) as ButtonValue;
    } catch {
      return;
    }
    // The alert's own thread (for an alert posted inside a thread, that thread).
    const threadTs = container?.thread_ts ?? ts;
    if (action.action_id.startsWith(ACTION_SHOW)) {
      const ans = await this.run({ kind: "show", terminal: value.t, lines: 40 }, { user, channel, threadTs });
      await this.answer({ user, channel, threadTs }, ans);
      return;
    }
    if (action.action_id.startsWith(ACTION_KEY)) {
      const key = keyFor(value.k);
      if (!key) return;
      const err = await this.press(value.t, key);
      this.followUp.set(value.t, { channel, ts: threadTs, at: Date.now() });
      log(`${user} pressed ${value.k} in ${value.t}`);
      await this.post(
        channel,
        { text: err ? `:warning: ${err}` : `<@${user}> pressed \`${escapeSlack(value.k)}\` in *${escapeSlack(value.t)}*` },
        value.t,
        threadTs,
      );
    }
  }

  private async tellUnknown(user: string, channel: string, threadTs: string) {
    const last = this.toldUnknown.get(user) ?? 0;
    if (Date.now() - last < 10 * 60_000) return;
    this.toldUnknown.set(user, Date.now());
    log(`ignored ${user} (not in SLACK_ALLOWED_USERS)`);
    await slackApi(this.token, "chat.postEphemeral", { channel, user, text: unknownText(user), thread_ts: threadTs }).catch(() => {});
  }

  // ── Replies into a terminal ──

  private async press(name: string, key: { named: string } | { text: string }): Promise<string | null> {
    const t = (await listTerminals()).find((x) => x.name === name);
    if (!t) return `There's no terminal *${escapeSlack(name)}* any more.`;
    if (t.dead) return `*${escapeSlack(name)}* has exited.`;
    if ("named" in key) await sendKey(name, key.named);
    else await sendText(name, key.text);
    return null;
  }

  private async reply(name: string, text: string, user: string, channel: string, threadTs: string, msgTs: string) {
    const t = (await listTerminals()).find((x) => x.name === name);
    const fail = (message: string) => this.post(channel, { text: `:warning: ${message}` }, undefined, threadTs);
    if (!t) return fail(`There's no terminal *${escapeSlack(name)}* any more.`);
    if (t.dead) return fail(`*${escapeSlack(name)}* has exited.`);
    const r = parseReply(text, t.status);
    if (r.kind === "error") return fail(r.message);
    if (r.kind === "key") {
      if ("named" in r.key) await sendKey(name, r.key.named);
      else await sendText(name, r.key.text);
    } else {
      await sendText(name, r.text);
      await sendKey(name, "Enter");
    }
    log(`${user} typed into ${name}: ${r.kind === "line" ? r.text.slice(0, 120) : JSON.stringify(r.key)}`);
    this.followUp.set(name, { channel, ts: threadTs, at: Date.now() });
    this.remember(threadTs, channel, name);
    await slackApi(this.token, "reactions.add", { channel, timestamp: msgTs, name: "white_check_mark" }).catch(() => {});
  }

  // ── Commands ──

  private async answer(ctx: Ctx, a: Answer) {
    if (ctx.responseUrl) {
      await respond(ctx.responseUrl, { response_type: "ephemeral", text: a.text, ...(a.blocks ? { blocks: a.blocks } : {}) });
      return;
    }
    try {
      const r = await this.post(ctx.channel, a, a.terminal, ctx.threadTs);
      if (a.terminal && a.follow) this.followUp.set(a.terminal, { channel: r.channel, ts: ctx.threadTs ?? r.ts, at: Date.now() });
    } catch (e) {
      if (e instanceof SlackError) log(`answer: ${e.message}`);
      else throw e;
    }
  }

  private async findTerminal(name: string): Promise<Terminal | string> {
    const list = await listTerminals();
    const exact = list.find((t) => t.name === name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    const ci = list.filter((t) => t.name.toLowerCase() === lower);
    if (ci.length === 1) return ci[0];
    const pre = list.filter((t) => t.name.toLowerCase().startsWith(lower));
    if (pre.length === 1) return pre[0];
    if (pre.length > 1) return `\`${escapeSlack(name)}\` could be ${pre.map((t) => `*${escapeSlack(t.name)}*`).join(", ")}.`;
    return `There's no terminal \`${escapeSlack(name)}\`. \`status\` lists them.`;
  }

  private async findProject(slug: string): Promise<{ id: number; slug: string } | string> {
    const id = await getProjectIdBySlug(slug);
    if (id !== null) return { id, slug };
    const all = await this.projectList();
    const lower = slug.toLowerCase();
    const hit = all.filter((p) => p.slug.toLowerCase() === lower);
    const pre = hit.length ? hit : all.filter((p) => p.slug.toLowerCase().startsWith(lower));
    if (pre.length === 1) return pre[0];
    if (pre.length > 1) return `\`${escapeSlack(slug)}\` could be ${pre.map((p) => `*${escapeSlack(p.slug)}*`).join(", ")}.`;
    return `There's no project \`${escapeSlack(slug)}\`. \`projects\` lists them.`;
  }

  private projectList() {
    return db
      .select({ id: projects.id, slug: projects.slug })
      .from(projects)
      .where(eq(projects.archived, false))
      .orderBy(asc(projects.slug));
  }

  private async run(cmd: Command, ctx: Ctx): Promise<Answer> {
    switch (cmd.kind) {
      case "help":
        return { text: HELP };
      case "error":
        return { text: cmd.message };
      case "status": {
        const list = await listTerminals();
        return { text: statusText(list, new Set(this.state.muted)) };
      }
      case "show": {
        const t = await this.findTerminal(cmd.terminal);
        if (typeof t === "string") return { text: t };
        const cap = await captureTerminal(t.name);
        return { ...screenMessage(t.name, cap.status, paneExcerpt(cap.content, null, cmd.lines)), terminal: t.name };
      }
      case "send": {
        const t = await this.findTerminal(cmd.terminal);
        if (typeof t === "string") return { text: t };
        const r = parseReply(cmd.text, t.status);
        if (r.kind === "error") return { text: r.message };
        if (t.dead) return { text: `*${escapeSlack(t.name)}* has exited.` };
        if (r.kind === "key") {
          if ("named" in r.key) await sendKey(t.name, r.key.named);
          else await sendText(t.name, r.key.text);
        } else {
          await sendText(t.name, r.text);
          await sendKey(t.name, "Enter");
        }
        log(`${ctx.user} sent to ${t.name}: ${cmd.text.slice(0, 120)}`);
        return { text: `Typed into *${escapeSlack(t.name)}*. I'll post here when it's done.`, terminal: t.name, follow: true };
      }
      case "key": {
        const t = await this.findTerminal(cmd.terminal);
        if (typeof t === "string") return { text: t };
        const err = await this.press(t.name, keyFor(cmd.key)!);
        log(`${ctx.user} pressed ${cmd.key} in ${t.name}`);
        return { text: err ?? `Pressed \`${escapeSlack(cmd.key)}\` in *${escapeSlack(t.name)}*.`, terminal: t.name, follow: !err };
      }
      case "ask": {
        try {
          const answer = await askAboutTerminals(cmd.question, "text");
          // Slack's bold is *one* star.
          return { text: escapeSlack(answer || "I'm not sure how to answer that.").replace(/\*\*(.+?)\*\*/g, "*$1*") };
        } catch (e) {
          return { text: `:warning: I couldn't ask Claude: ${escapeSlack((e as Error).message)}` };
        }
      }
      case "projects": {
        const all = await this.projectList();
        return { text: all.length ? all.map((p) => `• ${escapeSlack(p.slug)}`).join("\n") : "No projects." };
      }
      case "tasks": {
        const p = await this.findProject(cmd.project);
        if (typeof p === "string") return { text: p };
        return { text: tasksText(p.slug, await getTasks(p.id), cmd.all) };
      }
      case "task-add": {
        const p = await this.findProject(cmd.project);
        if (typeof p === "string") return { text: p };
        const id = await addTask(p.id, cmd.title);
        log(`${ctx.user} added task #${id} to ${p.slug}`);
        return { text: `Added #${id} to *${escapeSlack(p.slug)}*: ${escapeSlack(cmd.title)}` };
      }
      case "task-status": {
        const p = await this.findProject(cmd.project);
        if (typeof p === "string") return { text: p };
        const task = await getTask(p.id, cmd.id);
        if (!task) return { text: `*${escapeSlack(p.slug)}* has no task #${cmd.id}.` };
        await setTaskStatus(p.id, cmd.id, cmd.status);
        log(`${ctx.user} set ${p.slug}#${cmd.id} to ${cmd.status}`);
        const label = { open: "open", in_progress: "in progress", done: "done" }[cmd.status];
        return { text: `#${cmd.id} ${escapeSlack(task.title)} is ${label}.` };
      }
      case "mute": {
        if (!cmd.terminal) {
          return { text: this.state.muted.length ? `Muted: ${this.state.muted.map((m) => `*${escapeSlack(m)}*`).join(", ")}` : "Nothing is muted." };
        }
        const t = await this.findTerminal(cmd.terminal);
        const name = typeof t === "string" ? cmd.terminal : t.name;
        if (!this.state.muted.includes(name)) this.state.muted.push(name);
        this.save();
        return { text: `:no_bell: No more alerts from *${escapeSlack(name)}*.` };
      }
      case "unmute": {
        const lower = cmd.terminal.toLowerCase();
        const before = this.state.muted.length;
        this.state.muted = this.state.muted.filter((m) => m.toLowerCase() !== lower);
        this.save();
        return { text: before === this.state.muted.length ? `*${escapeSlack(cmd.terminal)}* wasn't muted.` : `:bell: Alerts from *${escapeSlack(cmd.terminal)}* are back on.` };
      }
    }
  }
}

function unknownText(user: string): string {
  return `You can't use this bot yet. Your Slack user id is \`${user}\`: someone with access to the server can add it to SLACK_ALLOWED_USERS in admin/.env.local and restart the admin.`;
}

// One bot per process (dev hot-reloads re-run instrumentation).
const g = globalThis as unknown as { __slackBot?: Bot };

/** Starts the bot when it's configured; logs and returns otherwise. Never throws. */
export async function startSlackBot(): Promise<void> {
  if (g.__slackBot) return;
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  const appToken = process.env.SLACK_APP_TOKEN?.trim();
  if (!token || !appToken) return;
  if (!token.startsWith("xoxb-") || !appToken.startsWith("xapp-")) {
    log("SLACK_BOT_TOKEN must be the xoxb- bot token and SLACK_APP_TOKEN the xapp- app-level token; not starting");
    return;
  }
  const allowed = parseAllowed(process.env.SLACK_ALLOWED_USERS);
  if (!allowed.size) log("SLACK_ALLOWED_USERS is empty: the bot will answer no one but tell people their user id");
  const host = (process.env.APP_PUBLIC_HOSTS ?? "").split(",")[0]?.trim();
  const terminalsUrl = host ? `https://${host}${process.env.APP_BASE_PATH || "/admin"}/terminals` : null;
  const bot = new Bot(
    token,
    appToken,
    allowed,
    process.env.SLACK_CHANNEL?.trim() || null,
    (process.env.SLACK_ALERTS ?? "on").trim().toLowerCase() !== "off",
    terminalsUrl,
  );
  g.__slackBot = bot;
  try {
    await bot.start();
  } catch (e) {
    log(`not started: ${(e as Error).message}`);
    bot.stop();
    g.__slackBot = undefined;
  }
}
