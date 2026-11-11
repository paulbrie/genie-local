import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { apps, projects, tasks, vercelIssues } from "@/db/schema";
import { connectedSessions, failuresLastDay, LOGIN_FAILURES, type LoginFailure, recentLogins } from "@/lib/admin-auth-log";
import { listDocker } from "@/lib/docker";
import { listServices } from "@/lib/services";
import { describeUserAgent } from "@/lib/user-agent";
import { healthOf, type HealthItem, parseGitStatus, type RepoState } from "@/lib/widgets-core";

// The data behind the desktop's widgets that start off (WIDGETS_OFF in lib/desktop.ts), one function per widget and
// one route each under /api/widgets. Small answers: a widget shows a glance, its page has the rest.

const pexec = promisify(execFile);

/** Health: the curated services and the containers, the ones that need you first. */
export async function healthData(): Promise<{ items: HealthItem[]; available: { services: boolean; docker: boolean } }> {
  const [svc, dock] = await Promise.all([listServices(), listDocker()]);
  return { items: healthOf(svc.services, dock.containers), available: { services: svc.available, docker: dock.available } };
}

/** Production errors: the open Vercel issues seen this week, the latest first, with their project. */
export async function errorsData() {
  const week = new Date(Date.now() - 7 * 86_400_000);
  const rows = await db
    .select({
      id: vercelIssues.id,
      slug: projects.slug,
      title: vercelIssues.title,
      level: vercelIssues.level,
      kind: vercelIssues.kind,
      count: vercelIssues.count,
      lastSeen: vercelIssues.lastSeen,
    })
    .from(vercelIssues)
    .innerJoin(projects, eq(projects.id, vercelIssues.projectId))
    .where(and(isNull(vercelIssues.dismissedAt), gte(vercelIssues.lastSeen, week)))
    .orderBy(desc(vercelIssues.lastSeen))
    .limit(40);
  return { issues: rows.map((r) => ({ ...r, lastSeen: r.lastSeen.toISOString() })) };
}

export type RepoRow = RepoState & { slug: string; app: string; path: string };

const GIT_FRESH_MS = 30_000;
const g = globalThis as { __gitWidget?: { at: number; p: Promise<{ repos: RepoRow[]; total: number }> } };

/** Git: every repo's branch, how far it is from its upstream, and what's changed in it (asked of git, every 30 s at most). */
export function gitData(): Promise<{ repos: RepoRow[]; total: number }> {
  if (g.__gitWidget && Date.now() - g.__gitWidget.at < GIT_FRESH_MS) return g.__gitWidget.p;
  const p = (async () => {
    const list = await db
      .select({ slug: projects.slug, app: apps.slug, path: apps.path })
      .from(apps)
      .innerJoin(projects, eq(projects.id, apps.projectId))
      .where(and(eq(apps.isGit, true), eq(projects.archived, false)))
      .orderBy(asc(projects.slug), asc(apps.slug));
    const repos = await Promise.all(
      list.map(async (r) => {
        try {
          const { stdout } = await pexec("git", ["-C", r.path, "status", "--porcelain=v2", "--branch"], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
          return { ...r, ...parseGitStatus(stdout) };
        } catch {
          return null;
        }
      }),
    );
    const ok = repos.filter((r): r is RepoRow => !!r);
    return { repos: ok, total: list.length };
  })();
  p.catch(() => (g.__gitWidget = undefined));
  g.__gitWidget = { at: Date.now(), p };
  return p;
}

/** Tickets: what's in progress (and who has it), then what's to do, across the projects. */
export async function ticketsData() {
  const rows = await db
    .select({ id: tasks.id, slug: projects.slug, title: tasks.title, status: tasks.status, assignee: tasks.assignee })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(inArray(tasks.status, ["in_progress", "open"]), eq(projects.archived, false)))
    .orderBy(sql`${tasks.status} = 'open'`, asc(projects.slug), asc(tasks.position), asc(tasks.id))
    .limit(60);
  return {
    inProgress: rows.filter((r) => r.status === "in_progress").length,
    open: rows.filter((r) => r.status === "open").length,
    tasks: rows,
  };
}

/** Sign-ins: who's connected now, and the sign-ins that failed today (the latest few, and how many by reason). */
export async function signinsData() {
  const [connected, failed, byReason] = await Promise.all([connectedSessions(), recentLogins({ failedOnly: true, limit: 6 }), failuresLastDay()]);
  const reason = (r: string | null) => (r && r in LOGIN_FAILURES ? LOGIN_FAILURES[r as LoginFailure] : (r ?? "failed"));
  const day = Date.now() - 86_400_000;
  return {
    connected: connected.map((s) => ({
      key: s.id.slice(0, 8),
      who: s.email ?? (s.via === "genie" ? "Genie sign-in" : "admin (password)"),
      browser: describeUserAgent(s.userAgent),
      ip: s.ip,
      since: s.createdAt.toISOString(),
    })),
    failedToday: byReason.reduce((n, r) => n + r.n, 0),
    failed: failed
      .filter((f) => +f.at > day)
      .map((f) => ({ id: f.id, at: f.at.toISOString(), reason: reason(f.reason), username: f.username, ip: f.ip })),
  };
}
