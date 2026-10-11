import { NextResponse } from "next/server";

import { shownRepoFiles } from "@/lib/agents3d";
import { readRepoFile } from "@/lib/repo-file-guard";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/**
 * A file of a repo on Agents City's map, as text, for the Ops view's read-only code window (T197).
 * GET /api/agents3d/file?repo=<repo top dir>&path=<repo-relative path>
 * Behind the admin sign-in (proxy.ts). Only a file the map shows, inside its repo after `..` and symlinks are
 * resolved, at most 1 MB, text, not a secret by name or content (lib/repo-file-guard.ts); anything else refused
 * with the reason.
 */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const repo = q.get("repo") ?? "", rel = q.get("path") ?? "";
  if (!repo || !rel) return NextResponse.json({ error: "repo and path are needed" }, { status: 400, headers: noStore });
  const r = await readRepoFile(repo, rel, await shownRepoFiles(repo));
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status, headers: noStore });
  return NextResponse.json({ path: rel, text: r.text, bytes: r.bytes }, { headers: noStore });
}
