import "server-only";

import { execFile } from "node:child_process";
import { existsSync, promises as fs, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { AGENTS_ROOT } from "@/lib/agents";
import { readRegistry } from "@/lib/claude-comms";
import {
  buildNewSessionArgs,
  buildRespawnArgs,
  launchPlan,
  parseTeam,
  STOP_MESSAGE,
  type TeamMember,
  type TeamRecipe,
} from "@/lib/teams-core";
import {
  captureTerminal,
  createTerminalRunning,
  killTerminal,
  listTerminals,
  respawnTerminal,
  sendKey,
  sendText,
  type Terminal,
} from "@/lib/terminals";

/**
 * Team recipes, the IO part: load `<TEAMS_ROOT>/<slug>/team.json` (+ prompt
 * files), report each member's live tmux state, and start / stop / close a
 * team's `admin-<Name>` sessions through terminals.ts (execFile, argument
 * arrays). Only a recipe's own members' sessions are ever created or killed.
 */
const execFileAsync = promisify(execFile);

export const TEAMS_ROOT = process.env.TEAMS_ROOT ?? path.resolve(AGENTS_ROOT, "..", "teams");

export type TeamFile = { slug: string; recipe: TeamRecipe | null; errors: string[] };

export async function loadTeams(): Promise<TeamFile[]> {
  let slugs: string[];
  try {
    slugs = (await fs.readdir(TEAMS_ROOT, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: TeamFile[] = [];
  for (const slug of slugs.sort()) out.push(await loadTeam(slug));
  return out;
}

export async function loadTeam(slug: string): Promise<TeamFile> {
  const dir = path.join(TEAMS_ROOT, slug);
  if (path.dirname(dir) !== path.resolve(TEAMS_ROOT)) return { slug, recipe: null, errors: ["invalid team"] };
  let json: string;
  try {
    json = await fs.readFile(path.join(dir, "team.json"), "utf8");
  } catch {
    return { slug, recipe: null, errors: ["team.json not found"] };
  }
  const readPrompt = (file: string) => {
    const p = path.join(dir, file);
    if (path.dirname(p) !== dir) return null;
    try {
      return statSync(p).isFile() ? readFileSync(p, "utf8") : null;
    } catch {
      return null;
    }
  };
  const dirExists = (p: string) => {
    try {
      return existsSync(p) && statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const r = parseTeam(slug, json, readPrompt, dirExists);
  return r.ok ? { slug, recipe: r.recipe, errors: [] } : { slug, recipe: null, errors: r.errors };
}

// ── Live state ───────────────────────────────────────────────────────────────

export type MemberState = {
  name: string;
  running: boolean;
  exited: boolean;
  status: Terminal["status"] | null;
  /** The member's tmux session (admin-<terminal name>), or null when not running in one. */
  target: string | null;
  /** Running, but not in an admin tmux session: shown, never touched. */
  outside: boolean;
  /** Since the last Stop: asked → working → answered (replied / idle again), or gone. */
  stop: "asked" | "working" | "answered" | "gone" | null;
};

type StopTrack = { at: number; members: Record<string, "asked" | "working" | "answered" | "gone"> };
const stops = new Map<string, StopTrack>();
/** An idle member that never shows a reply after the ask counts as answered after this long. */
const QUIET_ANSWER_MS = 90_000;

type Resolved = { term: Terminal | null; outside: boolean };

/**
 * Where each member runs. Sessions get renamed (Tatiana in `admin-termina`,
 * Ramona in `admin-ramona`), so the live session registry (the Claude
 * session's own name → its tmux pane) comes first, then `admin-<Name>`.
 */
async function resolveMembers(recipe: TeamRecipe): Promise<{ map: Map<string, Resolved>; terms: Terminal[] }> {
  const terms = await listTerminals();
  const byTarget = new Map(terms.map((t) => [t.target, t]));
  // The registry's tmux string is "<session at launch>:@<window>.%<pane>"; sessions get
  // renamed, but the pane id is stable, so map it to the pane's current session.
  const sessionOfPane = new Map<string, string>();
  try {
    const { stdout } = await execFileAsync("tmux", ["list-panes", "-a", "-F", "#{pane_id}\t#{session_name}"], { timeout: 5000 });
    for (const line of stdout.split("\n")) {
      const [pane, session] = line.split("\t");
      if (pane && session) sessionOfPane.set(pane, session);
    }
  } catch {
    /* no tmux server: nobody runs in one */
  }
  const { entries } = await readRegistry();
  const reg = new Map<string, { tmux: string | null }>();
  for (const e of entries) if (e.name) reg.set(e.name.toLowerCase(), { tmux: e.tmux });
  const map = new Map<string, Resolved>();
  for (const m of recipe.members) {
    const live = reg.get(m.name.toLowerCase());
    const pane = live?.tmux?.match(/(%\d+)$/)?.[1];
    const session = pane ? (sessionOfPane.get(pane) ?? null) : null;
    if (live) {
      const term = session ? (byTarget.get(session) ?? null) : null;
      map.set(m.name, { term, outside: !term });
      continue;
    }
    map.set(m.name, { term: byTarget.get(`admin-${m.name}`) ?? null, outside: false });
  }
  return { map, terms };
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** The member's pane shows a Claude reply (●) after our stop request. */
async function repliedAfterAsk(termName: string): Promise<boolean> {
  try {
    const { content } = await captureTerminal(termName);
    const text = content.replace(ANSI_RE, "");
    const at = text.lastIndexOf(STOP_MESSAGE.slice(0, 40));
    return at >= 0 && /\n\s*●/.test(text.slice(at));
  } catch {
    return false;
  }
}

export async function teamState(recipe: TeamRecipe): Promise<{ members: MemberState[]; stopAt: number | null }> {
  const { map } = await resolveMembers(recipe);
  const track = stops.get(recipe.slug);
  const members: MemberState[] = [];
  for (const m of recipe.members) {
    const { term: t, outside } = map.get(m.name)!;
    let stop = track?.members[m.name] ?? null;
    if (track && stop && stop !== "answered") {
      if (!t || t.dead) stop = outside ? stop : "gone";
      else if (t.status === "claude-working") stop = "working";
      else if (stop === "working" || Date.now() - track.at > QUIET_ANSWER_MS || (await repliedAfterAsk(t.name))) stop = "answered";
      track.members[m.name] = stop;
    }
    members.push({
      name: m.name,
      running: outside || (!!t && !t.dead),
      exited: !!t && t.dead,
      status: t?.status ?? null,
      target: t?.target ?? null,
      outside,
      stop,
    });
  }
  return { members, stopAt: track?.at ?? null };
}

/** Members already live anywhere (any tmux session, or outside the admin's). */
export async function liveMembers(recipe: TeamRecipe): Promise<Set<string>> {
  const { map } = await resolveMembers(recipe);
  return new Set([...map].filter(([, r]) => r.outside || r.term).map(([n]) => n));
}

// ── Actions ──────────────────────────────────────────────────────────────────

export type StepResult = { name: string; ok: boolean; message: string };

/** Start every member not already live (anywhere), lead first. Never touches running sessions. */
export async function startTeam(recipe: TeamRecipe): Promise<StepResult[]> {
  const plan = launchPlan(recipe, await liveMembers(recipe));
  const out: StepResult[] = [];
  for (const step of plan.steps) {
    if (step.skip) {
      out.push({ name: step.member.name, ok: true, message: "already running, skipped" });
      continue;
    }
    try {
      await createTerminalRunning(step.member.name, (target) => buildNewSessionArgs(target, step.member));
      out.push({ name: step.member.name, ok: true, message: "started" });
      // Give the lead a head start, so it is up before the others look for it.
      if (step.member.name === recipe.lead) await new Promise((r) => setTimeout(r, 4000));
    } catch (e) {
      out.push({ name: step.member.name, ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }
  stops.delete(recipe.slug);
  return out;
}

/** Restart an exited member's claude in its kept pane. */
export async function restartMember(recipe: TeamRecipe, name: string): Promise<StepResult> {
  const m = recipe.members.find((x) => x.name === name);
  if (!m) return { name, ok: false, message: "not a member of this team" };
  const { term: t } = (await resolveMembers(recipe)).map.get(name)!;
  if (!t) return { name, ok: false, message: "no session; use Start team" };
  if (!t.dead) return { name, ok: false, message: "still running" };
  try {
    await respawnTerminal(t.name, (target) => buildRespawnArgs(target, m));
    return { name, ok: true, message: "restarted" };
  } catch (e) {
    return { name, ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Ask every running member to commit or write a STATUS (typed into its Claude input). */
export async function stopTeam(recipe: TeamRecipe): Promise<StepResult[]> {
  const { map } = await resolveMembers(recipe);
  const track: StopTrack = { at: Date.now(), members: {} };
  const out: StepResult[] = [];
  for (const m of recipe.members) {
    const { term: t, outside } = map.get(m.name)!;
    if (outside) {
      out.push({ name: m.name, ok: false, message: "running outside the admin's terminals; ask it yourself" });
      continue;
    }
    if (!t || t.dead) {
      out.push({ name: m.name, ok: true, message: "not running" });
      continue;
    }
    if (t.status !== "claude-working" && t.status !== "claude-idle" && t.status !== "claude-input") {
      out.push({ name: m.name, ok: false, message: `not at a Claude prompt (${t.command || t.status}); not sent` });
      continue;
    }
    try {
      await sendText(t.name, STOP_MESSAGE);
      await sendKey(t.name, "Enter");
      track.members[m.name] = "asked";
      out.push({ name: m.name, ok: true, message: `asked (${t.target})` });
    } catch (e) {
      out.push({ name: m.name, ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }
  stops.set(recipe.slug, track);
  return out;
}

/** Kill the team members' own tmux sessions. Nothing else. */
export async function closeTeam(recipe: TeamRecipe): Promise<StepResult[]> {
  const { map } = await resolveMembers(recipe);
  const out: StepResult[] = [];
  for (const m of recipe.members as TeamMember[]) {
    const { term: t, outside } = map.get(m.name)!;
    if (outside) {
      out.push({ name: m.name, ok: false, message: "running outside the admin's terminals; not closed" });
      continue;
    }
    if (!t) {
      out.push({ name: m.name, ok: true, message: "no session" });
      continue;
    }
    try {
      await killTerminal(t.name);
      out.push({ name: m.name, ok: true, message: `closed ${t.target}` });
    } catch (e) {
      out.push({ name: m.name, ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }
  stops.delete(recipe.slug);
  return out;
}
