// Delete a local branch, from the Git tab (a branch label's right-click menu).
//   DELETE {project, app, branch, force?} → git branch -d (or -D), after the checks in deleteBranch;
//   unforced and unmerged → {deleted: false, unmerged: n}, nothing changed
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { listRepos, resolveRepo } from "@/lib/git-graph";
import { deleteBranch } from "@/lib/git-merge";
import { requireAdmin } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

const Body = z.object({
  project: z.string().min(1),
  app: z.string().default(""),
  branch: z.string().min(1).max(200),
  force: z.boolean().default(false),
});

const fail = (err: unknown, status = 400) =>
  NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status });

export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    return fail("unauthorized", 401);
  }
  try {
    const b = Body.parse(await req.json());
    const repo = await resolveRepo(b.project, b.app || ((await listRepos(b.project))[0]?.app ?? ""));
    if (!repo) throw new Error("no git repo");
    return NextResponse.json(await deleteBranch(repo, b.branch, b.force));
  } catch (err) {
    return fail(err instanceof z.ZodError ? "bad request" : err);
  }
}
