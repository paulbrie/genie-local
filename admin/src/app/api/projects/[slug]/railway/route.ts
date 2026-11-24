// A project's Railway tab (src/lib/railway-project.ts). A token is never sent back.
//   GET ?op=link                                   → { link, boxToken }  (link null: not linked; boxToken: RAILWAY_API_TOKEN is set)
//   GET ?op=scopes                                 → { kind, user, workspaces, fixed }
//   GET ?op=projects[&workspace=<id>]              → { projects }  (`matches`: one deploying this repo)
//   GET ?op=services                               → { services }  (each with its latest deployment and domains)
//   GET ?op=deployments[&limit=5][&after=<cursor>][&service=<id>] → { deployments, next }
//   GET ?op=build|deploy|http&deployment=<id>[&since=<ms>] → { lines }
//   GET ?op=issues[&dismissed=1]                   → { issues, collector }  (src/lib/railway-collector.ts)
//   POST {action: "ticket" | "dismiss" | "restore", id} → { taskId } | { ok }
//   PUT {token?, boxToken?, workspaceId?, projectId?, projectName?, environmentId?, environmentName?} → { link }
//   DELETE                                         → { ok }
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getProjectIdBySlug } from "@/lib/data";
import { requireAdmin } from "@/lib/require-admin";
import { dismissRailwayIssue, listRailwayIssues, railwayCollectorStatus, ticketFromRailwayIssue } from "@/lib/railway-collector";
import {
  forgetRailway,
  hasBoxToken,
  railwayBuildLogs,
  railwayDeployLogs,
  railwayDeployments,
  railwayHttpLogs,
  railwayLink,
  railwayProjects,
  railwayScopes,
  railwayServices,
  RailwayApiError,
  saveRailway,
} from "@/lib/railway-project";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

const fail = (err: unknown) =>
  NextResponse.json(
    { error: err instanceof Error ? err.message : String(err) },
    { status: err instanceof RailwayApiError ? err.status : err instanceof z.ZodError ? 400 : 500 },
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

const id = (v: string | null) => {
  if (!v || !/^[\w-]{4,80}$/.test(v)) throw new RailwayApiError("bad id", 400);
  return v;
};

export async function GET(req: NextRequest, { params }: Ctx) {
  const denied = await admin();
  if (denied) return denied;
  const { slug } = await params;
  const q = req.nextUrl.searchParams;
  const since = Number(q.get("since")) || undefined;
  try {
    switch (q.get("op") ?? "link") {
      case "link":
        return ok({ link: await railwayLink(slug), boxToken: hasBoxToken() });
      case "scopes":
        return ok(await railwayScopes(slug));
      case "projects":
        return ok({ projects: await railwayProjects(slug, q.get("workspace") ? id(q.get("workspace")) : null) });
      case "services":
        return ok({ services: await railwayServices(slug) });
      case "deployments":
        return ok(await railwayDeployments(slug, Number(q.get("limit")) || 5, q.get("after") ?? undefined, q.get("service") ? id(q.get("service")) : undefined));
      case "build":
        return ok({ lines: await railwayBuildLogs(slug, id(q.get("deployment"))) });
      case "deploy":
        return ok({ lines: await railwayDeployLogs(slug, id(q.get("deployment")), since) });
      case "http":
        return ok({ lines: await railwayHttpLogs(slug, id(q.get("deployment")), since) });
      case "issues": {
        const pid = await getProjectIdBySlug(slug);
        if (pid === null) return NextResponse.json({ error: "no such project" }, { status: 404 });
        return ok({ issues: await listRailwayIssues(pid, q.get("dismissed") === "1"), collector: railwayCollectorStatus(pid) });
      }
      default:
        return NextResponse.json({ error: "unknown op" }, { status: 400 });
    }
  } catch (err) {
    return fail(err);
  }
}

const Put = z.object({
  token: z.string().max(500).optional(),
  boxToken: z.boolean().optional(),
  workspaceId: z.string().max(100).nullable().optional(),
  projectId: z.string().max(100).nullable().optional(),
  projectName: z.string().max(200).nullable().optional(),
  environmentId: z.string().max(100).nullable().optional(),
  environmentName: z.string().max(200).nullable().optional(),
});

export async function PUT(req: NextRequest, { params }: Ctx) {
  const denied = await admin();
  if (denied) return denied;
  const { slug } = await params;
  try {
    return ok({ link: await saveRailway(slug, Put.parse(await req.json())) });
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
    const { action, id: issue } = Post.parse(await req.json());
    const pid = await getProjectIdBySlug(slug);
    if (pid === null) return NextResponse.json({ error: "no such project" }, { status: 404 });
    if (action === "ticket") return ok({ taskId: await ticketFromRailwayIssue(pid, slug, issue, (await railwayLink(slug))?.projectName ?? null) });
    await dismissRailwayIssue(pid, issue, action === "dismiss");
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
    await forgetRailway(slug);
    return ok({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
