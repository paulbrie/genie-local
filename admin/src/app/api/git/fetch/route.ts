// POST {project, app}: `git fetch --all --prune` in the project's repo, for the
// Git tab's Refresh. Only remote-tracking refs (origin/…) change; no checkout,
// no local branch. Never prompts for credentials (fails fast instead).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { listRepos, resolveRepo } from "@/lib/git-graph";
import { requireAdmin } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

const run = promisify(execFile);

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const b = z.object({ project: z.string().min(1), app: z.string().default("") }).parse(await req.json());
    const app = b.app || ((await listRepos(b.project))[0]?.app ?? "");
    const repo = await resolveRepo(b.project, app);
    if (!repo) return NextResponse.json({ error: "no git repo" }, { status: 404 });
    const remotes = (await run("git", ["remote"], { cwd: repo, timeout: 5000 })).stdout.trim();
    if (!remotes) return NextResponse.json({ fetched: false, reason: "no remote" });
    await run("git", ["fetch", "--all", "--prune", "--quiet"], {
      cwd: repo,
      timeout: 45_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
    });
    return NextResponse.json({ fetched: true });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const msg = (e.stderr || e.message || String(err)).trim().split("\n").slice(-2).join(" ");
    return NextResponse.json({ fetched: false, reason: msg.slice(0, 300) });
  }
}
