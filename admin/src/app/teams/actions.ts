"use server";

import { z } from "zod";

import { assertAdmin } from "@/lib/teams-auth";
import { closeTeam, loadTeam, restartMember, startTeam, stopTeam, type StepResult } from "@/lib/teams";

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/);
const Member = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/);

type ActionResult = { ok: true; results: StepResult[] } | { ok: false; error: string };

/** Each action re-reads and re-validates the recipe from disk; a stale or edited page can't launch anything else. */
async function withRecipe(slug: string, fn: (r: NonNullable<Awaited<ReturnType<typeof loadTeam>>["recipe"]>) => Promise<StepResult[]>): Promise<ActionResult> {
  try {
    await assertAdmin();
    const s = Slug.parse(slug);
    const team = await loadTeam(s);
    if (!team.recipe) return { ok: false, error: `Recipe invalid: ${team.errors.join("; ")}` };
    return { ok: true, results: await fn(team.recipe) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function startTeamAction(slug: string): Promise<ActionResult> {
  return withRecipe(slug, (r) => startTeam(r));
}

export async function stopTeamAction(slug: string): Promise<ActionResult> {
  return withRecipe(slug, (r) => stopTeam(r));
}

export async function closeTeamAction(slug: string): Promise<ActionResult> {
  return withRecipe(slug, (r) => closeTeam(r));
}

export async function restartMemberAction(slug: string, name: string): Promise<ActionResult> {
  return withRecipe(slug, async (r) => [await restartMember(r, Member.parse(name))]);
}
