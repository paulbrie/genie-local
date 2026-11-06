import path from "node:path";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { extLink } from "@/lib/browsers/ext";
import { discoverProjectSlugs, PROJECTS_ROOT } from "@/lib/signals";
import { listTerminals } from "@/lib/terminals";

export const dynamic = "force-dynamic";

/** For the extension's chat bubble: the terminals to talk to, and the projects a new talk can start in. */
export async function GET(req: NextRequest) {
  if (!(await extLink(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const root = path.resolve(PROJECTS_ROOT);
  const [terminals, projects] = await Promise.all([listTerminals(), discoverProjectSlugs().catch(() => [])]);
  return NextResponse.json(
    {
      terminals: terminals.map((t) => {
        const rel = path.relative(root, t.cwd);
        return {
          name: t.name,
          status: t.status,
          dead: t.dead,
          project: rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep)[0] : null,
          createdAt: t.createdAt,
        };
      }),
      projects: projects.sort(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
