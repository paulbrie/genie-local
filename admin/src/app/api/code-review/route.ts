import { NextResponse } from "next/server";
import { z } from "zod";

import { projectReview, saveProjectReview } from "@/lib/code-review";
import { requireAdmin } from "@/lib/require-admin";

export const dynamic = "force-dynamic";

async function authed() {
  try {
    await requireAdmin();
    return true;
  } catch {
    return false;
  }
}

/** A project's review-before-push settings, its repos' hooks, and its latest reviews: `?slug=<project>`. */
export async function GET(req: Request) {
  if (!(await authed())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const slug = new URL(req.url).searchParams.get("slug")?.trim();
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });
  const review = await projectReview(slug);
  if (!review) return NextResponse.json({ error: "no such project" }, { status: 404 });
  return NextResponse.json(review, { headers: { "Cache-Control": "no-store" } });
}

const pattern = z.string().trim().min(1).max(200);
const bodySchema = z.object({
  slug: z.string().trim().min(1).max(200),
  settings: z.object({
    enabled: z.boolean(),
    branches: z.array(pattern).max(50),
    blockAt: z.enum(["high", "medium", "low", "never"]),
    who: z.enum(["both", "agents", "people"]),
    effort: z.enum(["low", "medium", "high"]),
    skip: z.array(pattern).max(100),
    timeoutSec: z.number().int().min(30).max(1800),
  }),
});

/** Save `{ slug, settings }`: written for each of the project's repos, their hooks installed or removed to match. */
export async function POST(req: Request) {
  if (!(await authed())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  try {
    const review = await saveProjectReview(parsed.data.slug, parsed.data.settings);
    if (!review) return NextResponse.json({ error: "no such project" }, { status: 404 });
    return NextResponse.json(review);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.split("\n")[0] }, { status: 500 });
  }
}
