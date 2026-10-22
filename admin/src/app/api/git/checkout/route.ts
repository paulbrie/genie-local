// Switch the repo's main checkout to another local branch, from the Git tab.
//   POST {project, app, branch} → git switch, after the checks in switchBranch
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { listRepos, resolveRepo } from "@/lib/git-graph";
import { switchBranch } from "@/lib/git-merge";
import { requireAdmin } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

const Body = z.object({
  project: z.string().min(1),
  app: z.string().default(""),
  branch: z.string().min(1).max(200),
});

const fail = (err: unknown, status = 400) =>
  NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status });

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    return fail("unauthorized", 401);
  }
  try {
    const b = Body.parse(await req.json());
    const repo = await resolveRepo(b.project, b.app || ((await listRepos(b.project))[0]?.app ?? ""));
    if (!repo) throw new Error("no git repo");
    return NextResponse.json(await switchBranch(repo, b.branch));
  } catch (err) {
    return fail(err instanceof z.ZodError ? "bad request" : err);
  }
}
