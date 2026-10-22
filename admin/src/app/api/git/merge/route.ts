// Local merges, from the Git tab: into the branch of the repo's main checkout.
//   GET  ?project&app            → the branches ahead of it (candidates)
//   GET  ?project&app&branch     → what merging that branch would do (nothing changes)
//   POST {project, app, branch, expectHead} → merge it (re-checked first)
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { mergeBranch, mergeCandidates, previewMerge } from "@/lib/git-merge";
import { listRepos, resolveRepo } from "@/lib/git-graph";
import { requireAdmin } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

async function repoOf(project: string | null, app: string | null): Promise<string> {
  if (!project) throw new Error("project required");
  const a = app || ((await listRepos(project))[0]?.app ?? "");
  const repo = await resolveRepo(project, a);
  if (!repo) throw new Error("no git repo");
  return repo;
}

const fail = (err: unknown, status = 400) =>
  NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status });

export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    return fail("unauthorized", 401);
  }
  const q = req.nextUrl.searchParams;
  try {
    const repo = await repoOf(q.get("project"), q.get("app"));
    const branch = q.get("branch");
    return NextResponse.json(branch ? await previewMerge(repo, branch) : await mergeCandidates(repo), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return fail(err);
  }
}

const Body = z.object({
  project: z.string().min(1),
  app: z.string().default(""),
  branch: z.string().min(1).max(200),
  expectHead: z.string().regex(/^[0-9a-f]{40}$/),
});

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    return fail("unauthorized", 401);
  }
  try {
    const b = Body.parse(await req.json());
    const repo = await repoOf(b.project, b.app);
    return NextResponse.json(await mergeBranch(repo, b.branch, b.expectHead));
  } catch (err) {
    return fail(err instanceof z.ZodError ? "bad request" : err);
  }
}
