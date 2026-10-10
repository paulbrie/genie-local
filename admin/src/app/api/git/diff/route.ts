import { NextResponse } from "next/server";

import { getCommitDiff, resolveRepo } from "@/lib/git-graph";

export const dynamic = "force-dynamic";

/**
 * The full patch for one commit.
 * GET /api/git/diff?project=<slug>&app=<appSlug>&hash=<sha>
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const project = searchParams.get("project");
  const app = searchParams.get("app") ?? "";
  const hash = searchParams.get("hash");
  if (!project || !hash)
    return NextResponse.json(
      { error: "project and hash required" },
      { status: 400 },
    );

  let repoDir: string | null;
  try {
    repoDir = await resolveRepo(project, app);
  } catch {
    return NextResponse.json({ error: "invalid project" }, { status: 400 });
  }
  if (!repoDir)
    return NextResponse.json({ error: "no git repo" }, { status: 404 });

  const diff = await getCommitDiff(repoDir, hash);
  if (!diff)
    return NextResponse.json({ error: "commit not found" }, { status: 404 });

  return NextResponse.json(diff, { headers: { "Cache-Control": "no-store" } });
}
