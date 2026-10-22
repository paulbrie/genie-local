import { NextResponse } from "next/server";

import { listRepos, resolveRepo } from "@/lib/git-graph";
import { listWorktrees } from "@/lib/worktrees";

export const dynamic = "force-dynamic";

/**
 * The worktrees of one project's repo (agents work in their own), each with
 * its branch, uncommitted changes, ahead / behind the main checkout, last
 * commit and the terminals working in it.
 *
 * GET /api/git/worktrees?project=<slug>&app=<appSlug>
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const project = searchParams.get("project");
  if (!project) return NextResponse.json({ error: "project required" }, { status: 400 });
  let app = searchParams.get("app") ?? "";
  let repo: string | null;
  try {
    if (!app) app = (await listRepos(project))[0]?.app ?? "";
    repo = await resolveRepo(project, app);
  } catch {
    return NextResponse.json({ error: "invalid project" }, { status: 400 });
  }
  if (!repo) return NextResponse.json({ error: "no git repo" }, { status: 404 });
  try {
    return NextResponse.json({ worktrees: await listWorktrees(repo) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "git failed" }, { status: 500 });
  }
}
