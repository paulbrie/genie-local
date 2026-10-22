// Commit from the Git tab, in the checkout the view shows (and push, if asked).
//   POST {project, app, view, message, paths[], push?} → { sha, files, pushed? }
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { commitChanges, pushBranch } from "@/lib/git-commit";
import { listRepos, parseView, resolveRepo } from "@/lib/git-graph";
import { requireAdmin } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

const Body = z.object({
  project: z.string().min(1),
  app: z.string().default(""),
  view: z.string().default(""),
  message: z.string().trim().min(1).max(20_000),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(5000),
  push: z.boolean().default(false),
});

const fail = (err: unknown, status = 400) =>
  NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status });

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    return fail("unauthorized", 401);
  }
  let b: z.infer<typeof Body>;
  try {
    b = Body.parse(await req.json());
  } catch {
    return fail("bad request");
  }
  try {
    const repo = await resolveRepo(b.project, b.app || ((await listRepos(b.project))[0]?.app ?? ""));
    if (!repo) throw new Error("no git repo");
    const view = parseView(b.view);
    const commit = await commitChanges(repo, view, b.message, b.paths);
    if (!b.push) return NextResponse.json(commit);
    // committed either way: a failed push is reported next to it
    try {
      return NextResponse.json({ ...commit, push: await pushBranch(repo, view) });
    } catch (err) {
      return NextResponse.json({ ...commit, pushError: err instanceof Error ? err.message : String(err) });
    }
  } catch (err) {
    return fail(err);
  }
}
