// Push from the Git tab: the view's checkout's branch to origin/<same name>.
//   POST {project, app, view} → { branch, pushed, created }
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { gitRemoteEnv } from "@/lib/git-auth";
import { pushBranch } from "@/lib/git-commit";
import { listRepos, parseView, resolveRepo } from "@/lib/git-graph";
import { requireAdmin } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

const Body = z.object({
  project: z.string().min(1),
  app: z.string().default(""),
  view: z.string().default(""),
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
    const app = b.app || ((await listRepos(b.project))[0]?.app ?? "");
    const repo = await resolveRepo(b.project, app);
    if (!repo) throw new Error("no git repo");
    return NextResponse.json(await pushBranch(repo, parseView(b.view), await gitRemoteEnv(b.project, app)));
  } catch (err) {
    return fail(err instanceof z.ZodError ? "bad request" : err);
  }
}
