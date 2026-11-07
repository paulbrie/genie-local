import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { browserBridge } from "@/lib/browsers/db";
import { extLink } from "@/lib/browsers/ext";
import { PROJECTS_ROOT, resolveProjectPath } from "@/lib/signals";
import { sendBrief, startAgent } from "@/lib/task-delegate";
import { listTerminals, sendKey, sendText, toTarget } from "@/lib/terminals";

export const dynamic = "force-dynamic";

const schema = z.object({
  text: z.string().trim().min(1).max(20_000),
  // an existing terminal, or none: a new talk (a new Claude terminal), in `project` if given
  terminal: z.string().min(1).max(64).optional(),
  project: z.string().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(64).optional(),
  // the tab it was said from, so the agent knows where "this page" is (and can drive it with the browsers MCP)
  page: z.object({ url: z.string().max(2000), title: z.string().max(300), tabId: z.number().int().optional() }).optional(),
  // said from Spiridus Desktop's chat, about that computer ("this screen")
  computer: z.boolean().optional(),
});

/**
 * The extension's chat bubble saying something: typed into a terminal (and
 * submitted), or as the first prompt of a new Claude terminal. Answers the
 * terminal's name.
 */
export async function POST(req: NextRequest) {
  const link = await extLink(req);
  if (!link) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const { text, terminal, project, name, page, computer } = parsed.data;

  // One line: a newline typed into a terminal would submit there and then.
  const said = text.replace(/\s*\n\s*/g, " ");
  // Only a tab the person shared (or Spiridus opened) can be driven: say which, so the agent doesn't assume it can.
  const shared = page?.tabId != null && !!browserBridge()?.get(link.id)?.tabs.some((t) => t.id === page.tabId);
  const reach = shared
    ? "the browsers MCP tools can read and drive that tab"
    : "that tab is not shared with Spiridus, so the browsers MCP tools can't reach it: ask them to share it from the extension's popup, or open the page in a new tab with browser_open";
  const where =
    computer && link.kind === "desktop"
      ? ` (Said from the computer "${link.name}", Spiridus device #${link.id}: the browsers MCP desktop_* tools can see its screen and drive it.)`
      : page
        ? ` (Said from ${link.name}'s Chrome, tab ${page.tabId ?? "?"}: "${page.title.replace(/\s+/g, " ")}" ${page.url}. It is Spiridus browser #${link.id}: ${reach}.)`
        : "";
  const brief = said + where;

  try {
    if (terminal) {
      const t = (await listTerminals()).find((x) => x.name === terminal);
      if (!t || t.dead) return NextResponse.json({ error: `"${terminal}" is gone` }, { status: 404 });
      if (t.status.startsWith("claude-")) await sendBrief(terminal, brief);
      else {
        await sendText(terminal, said);
        await sendKey(terminal, "Enter");
      }
      return NextResponse.json({ terminal });
    }

    const cwd = project ? resolveProjectPath(project) : PROJECTS_ROOT;
    const taken = new Set((await listTerminals()).map((t) => t.name));
    let fresh = name ?? `talk-${project ?? "spiridus"}`;
    if (taken.has(fresh)) {
      let n = 2;
      while (taken.has(`${fresh}-${n}`)) n++;
      fresh = `${fresh}-${n}`;
    }
    toTarget(fresh); // throws on a name tmux can't take
    await startAgent(fresh, cwd, brief);
    return NextResponse.json({ terminal: fresh, started: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
