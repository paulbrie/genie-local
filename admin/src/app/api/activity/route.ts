// POST: a client-side navigation, from <ActivityBeacon>. Document loads are
// recorded by the proxy; RSC navigations can't be told from prefetches there
// (Next strips the router headers before proxy.ts), so the browser reports the
// pathname it actually landed on. Only the route pattern is kept.
import { NextRequest } from "next/server";

import { activityContext, recordActivity } from "@/lib/activity";
import { pageViewProps } from "@/lib/activity-routes";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySessionToken(token))) {
    return new Response(null, { status: 401 });
  }
  // sendBeacon posts text/plain; a pathname is all it carries.
  const text = (await req.text().catch(() => "")).slice(0, 2048);
  let pathname: unknown;
  try {
    pathname = (JSON.parse(text) as { path?: unknown }).path;
  } catch {
    pathname = null;
  }
  const props = typeof pathname === "string" ? pageViewProps(pathname.split(/[?#]/)[0]) : null;
  if (props) recordActivity("page.view", { ...activityContext(req, token), props });
  return new Response(null, { status: 204 });
}
