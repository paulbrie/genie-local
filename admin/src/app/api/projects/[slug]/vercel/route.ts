// A project's Vercel tab (src/lib/vercel.ts). The token is never sent back.
//   GET ?op=link                          → { link }   (null: no token yet)
//   GET ?op=scopes                        → { user, teams }
//   GET ?op=projects[&search=]            → { projects }  (`matches`: the one deploying this repo)
//   GET ?op=deployments[&limit=5][&until=<ms>] → { deployments, next }  (next: the `until` of the page after)
//   GET ?op=build&deployment=<id>         → { lines }
//   GET ?op=runtime&deployment=<id>       → NDJSON, live: one line per request / log as it happens, while open
//   GET ?op=issues[&dismissed=1]          → { issues, collector }  (production problems, src/lib/vercel-collector.ts)
//   POST {action: "ticket" | "dismiss" | "restore", id} → { taskId } | { ok }
//   PUT {token?, teamId?, projectId?, projectName?} → { link }
//   DELETE                                → { ok }
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getProjectIdBySlug } from "@/lib/data";
import { requireAdmin } from "@/lib/require-admin";
import { collectorStatus, dismissIssue, listIssues, ticketFromIssue } from "@/lib/vercel-collector";
import {
  forgetVercel,
  saveVercel,
  vercelBuildLogs,
  vercelDeployments,
  vercelLink,
  vercelProjects,
  vercelRuntimeStream,
  vercelScopes,
  VercelError,
} from "@/lib/vercel";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

const fail = (err: unknown) =>
  NextResponse.json(
    { error: err instanceof Error ? err.message : String(err) },
    { status: err instanceof VercelError ? err.status : err instanceof z.ZodError ? 400 : 500 },
  );
const ok = (body: unknown) => NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });

async function admin() {
  try {
    await requireAdmin();
    return null;
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const denied = await admin();
  if (denied) return denied;
  const { slug } = await params;
  const q = req.nextUrl.searchParams;
  const dep = q.get("deployment") ?? "";
  try {
    switch (q.get("op") ?? "link") {
      case "link":
        return ok({ link: await vercelLink(slug) });
      case "scopes":
        return ok(await vercelScopes(slug));
      case "projects":
        return ok({ projects: await vercelProjects(slug, q.get("search") ?? undefined) });
      case "issues": {
        const pid = await getProjectIdBySlug(slug);
        if (pid === null) return NextResponse.json({ error: "no such project" }, { status: 404 });
        return ok({ issues: await listIssues(pid, q.get("dismissed") === "1"), collector: collectorStatus(pid) });
      }
      case "deployments":
        return ok(await vercelDeployments(slug, Number(q.get("limit")) || 5, Number(q.get("until")) || undefined));
      case "build":
        if (!/^[\w-]{4,80}$/.test(dep)) return NextResponse.json({ error: "bad deployment" }, { status: 400 });
        return ok({ lines: await vercelBuildLogs(slug, dep) });
      case "runtime":
        if (!/^[\w-]{4,80}$/.test(dep)) return NextResponse.json({ error: "bad deployment" }, { status: 400 });
        return new NextResponse(await vercelRuntimeStream(slug, dep, req.signal), {
          headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
        });
      default:
        return NextResponse.json({ error: "unknown op" }, { status: 400 });
    }
  } catch (err) {
    return fail(err);
  }
}

const Put = z.object({
  token: z.string().max(500).optional(),
  teamId: z.string().max(100).nullable().optional(),
  projectId: z.string().max(100).nullable().optional(),
  projectName: z.string().max(200).nullable().optional(),
});

export async function PUT(req: NextRequest, { params }: Ctx) {
  const denied = await admin();
  if (denied) return denied;
  const { slug } = await params;
  try {
    return ok({ link: await saveVercel(slug, Put.parse(await req.json())) });
  } catch (err) {
    return fail(err);
  }
}

const Post = z.object({ action: z.enum(["ticket", "dismiss", "restore"]), id: z.number().int().positive() });

export async function POST(req: NextRequest, { params }: Ctx) {
  const denied = await admin();
  if (denied) return denied;
  const { slug } = await params;
  try {
    const { action, id } = Post.parse(await req.json());
    const pid = await getProjectIdBySlug(slug);
    if (pid === null) return NextResponse.json({ error: "no such project" }, { status: 404 });
    if (action === "ticket") return ok({ taskId: await ticketFromIssue(pid, slug, id, (await vercelLink(slug))?.projectName ?? null) });
    await dismissIssue(pid, id, action === "dismiss");
    return ok({ ok: true });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const denied = await admin();
  if (denied) return denied;
  const { slug } = await params;
  try {
    await forgetVercel(slug);
    return ok({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
