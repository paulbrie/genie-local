// The Git tab's Remote dialog: a repo's GitHub URL (its origin) and access token.
//   GET    ?project=&app=                         → { app, origin, saved }
//   PUT    {project, app, remoteUrl, token?, clearToken?} → { saved, check, origin }
//   DELETE {project, app}                          → { ok }
// The token is never sent back: `saved` says whether there is one, and its last 4 characters.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { currentOrigin, forgetRemote, savedRemote, saveRemote } from "@/lib/git-auth";
import { listRepos, resolveRepo } from "@/lib/git-graph";
import { requireAdmin } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

const fail = (err: unknown, status = 400) =>
  NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status });

async function repoOf(project: string, app: string) {
  const a = app || ((await listRepos(project))[0]?.app ?? "");
  const dir = await resolveRepo(project, a);
  if (!dir) throw new Error("no git repo");
  return { app: a, dir };
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    return fail("unauthorized", 401);
  }
  try {
    const sp = req.nextUrl.searchParams;
    const { app, dir } = await repoOf(sp.get("project") ?? "", sp.get("app") ?? "");
    const project = sp.get("project") ?? "";
    return NextResponse.json(
      { app, origin: await currentOrigin(dir), saved: await savedRemote(project, app) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return fail(err);
  }
}

const Put = z.object({
  project: z.string().min(1),
  app: z.string().default(""),
  remoteUrl: z.string().min(1).max(500),
  token: z.string().max(500).optional(),
  clearToken: z.boolean().optional(),
});

export async function PUT(req: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    return fail("unauthorized", 401);
  }
  try {
    const b = Put.parse(await req.json());
    const { app, dir } = await repoOf(b.project, b.app);
    const token = b.clearToken ? null : b.token?.trim() ? b.token : undefined;
    const r = await saveRemote(b.project, app, dir, { remoteUrl: b.remoteUrl, token });
    return NextResponse.json({ ...r, origin: await currentOrigin(dir) });
  } catch (err) {
    return fail(err instanceof z.ZodError ? "bad request" : err);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    return fail("unauthorized", 401);
  }
  try {
    const b = z.object({ project: z.string().min(1), app: z.string().default("") }).parse(await req.json());
    const { app } = await repoOf(b.project, b.app);
    await forgetRemote(b.project, app);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fail(err instanceof z.ZodError ? "bad request" : err);
  }
}
