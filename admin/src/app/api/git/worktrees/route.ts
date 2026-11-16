import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { listRepos, resolveRepo } from "@/lib/git-graph";
import { requireAdmin } from "@/lib/require-admin";
import { listWorktrees, removeWorktree, worktreeSizes } from "@/lib/worktrees";

export const dynamic = "force-dynamic";

/**
 * The worktrees of one project's repo (agents work in their own), each with
 * its branch, uncommitted changes, ahead / behind the main checkout, last
 * commit and the terminals working in it; with `sizes=1`, instead, the room
 * each takes on disk (du: asked for apart, it can take a while).
 *
 * GET /api/git/worktrees?project=<slug>&app=<appSlug>[&sizes=1]
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
    const body = searchParams.get("sizes") ? { sizes: await worktreeSizes(repo) } : { worktrees: await listWorktrees(repo) };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "git failed" }, { status: 500 });
  }
}

const Body = z.object({
  project: z.string().min(1),
  app: z.string().default(""),
  path: z.string().min(1).startsWith("/"),
  force: z.boolean().default(false),
});

/**
 * Delete a worktree (a worktree's right-click on the Git tab), after the checks in removeWorktree.
 *   DELETE {project, app, path, force?} → {removed: true, branch}; unforced, with uncommitted work in it or a lock on
 *   it → {removed: false, changes, lockedBy}, nothing changed
 */
export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const b = Body.parse(await req.json());
    const repo = await resolveRepo(b.project, b.app || ((await listRepos(b.project))[0]?.app ?? ""));
    if (!repo) throw new Error("no git repo");
    return NextResponse.json(await removeWorktree(repo, b.path, b.force));
  } catch (err) {
    const error = err instanceof z.ZodError ? "bad request" : err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error }, { status: 400 });
  }
}
