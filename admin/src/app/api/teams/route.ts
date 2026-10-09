import { NextResponse } from "next/server";

import { launchPlan, PERMISSION_INFO } from "@/lib/teams-core";
import { isAdminRequest } from "@/lib/teams-auth";
import { loadTeams, teamState } from "@/lib/teams";

export const dynamic = "force-dynamic";

/**
 * Teams with their members' live state and what Start would launch.
 * Prompts are summarised (first lines) for the confirm dialog.
 *
 * GET /api/teams
 */
export async function GET() {
  if (!(await isAdminRequest())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const teams = await loadTeams();
  const out = await Promise.all(
    teams.map(async (t) => {
      if (!t.recipe) return { slug: t.slug, errors: t.errors, recipe: null, state: null, plan: null };
      const state = await teamState(t.recipe);
      const running = new Set(state.members.filter((m) => m.running || m.exited).map((m) => m.name));
      const plan = launchPlan(t.recipe, running);
      return {
        slug: t.slug,
        errors: [],
        recipe: {
          ...t.recipe,
          members: t.recipe.members.map(({ prompt, ...m }) => ({
            ...m,
            promptPreview: prompt.split("\n").slice(0, 3).join("\n"),
            permissionInfo: PERMISSION_INFO[m.permissionMode],
          })),
        },
        state,
        plan: { launching: plan.launching, opus: plan.opus, skip: plan.steps.filter((s) => s.skip).map((s) => s.member.name) },
      };
    }),
  );
  return NextResponse.json({ teams: out }, { headers: { "Cache-Control": "no-store" } });
}
