import Link from "next/link";
import { notFound } from "next/navigation";

import { GitDiffPanel } from "@/components/git-diff-panel";
import { getCommitDiff, resolveRepo } from "@/lib/git-graph";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { parseCommitHeader } from "@/lib/parse-patch";
import { getProject } from "@/lib/project-page";

export const dynamic = "force-dynamic";

/** /projects/<slug>/git/<hash>[?app=<app>]: one commit, full page, files collapsed. */
export default async function ProjectCommitPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; hash: string }>;
  searchParams: Promise<{ app?: string | string[] }>;
}) {
  const { slug, hash } = await params;
  const query = await searchParams;
  const app = (Array.isArray(query.app) ? query.app[0] : query.app) ?? "";
  if (!(await getProject(slug))) notFound();
  const repo = await resolveRepo(slug, app).catch(() => null);
  const diff = repo ? await getCommitDiff(repo, hash) : null;
  if (!diff) notFound();

  const c = parseCommitHeader(diff.patch);
  const historyHref = `/projects/${encodeURIComponent(slug)}/git${app ? `?app=${encodeURIComponent(app)}` : ""}`;
  const authorName = c.author.replace(/\s*<[^>]*>$/, "");
  const date = new Date(c.authorDate);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Link href={historyHref} className="text-sm text-muted-foreground hover:underline">
          ← History{app ? ` (${app})` : ""}
        </Link>
        <h2 className="text-lg font-semibold">{c.subject || "(no message)"}</h2>
        {c.body && (
          <p className="max-w-4xl text-sm whitespace-pre-wrap text-muted-foreground">{c.body}</p>
        )}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground" title={c.hash}>
            {c.hash.slice(0, 10)}
          </span>
          <span title={c.author}>{authorName}</span>
          <span title={Number.isNaN(date.getTime()) ? c.authorDate : formatDateTime(date)}>
            {Number.isNaN(date.getTime()) ? c.authorDate : formatRelativeTime(date)}
          </span>
          {c.committer && c.committer !== c.author && (
            <span title={c.committer}>committed by {c.committer.replace(/\s*<[^>]*>$/, "")}</span>
          )}
        </p>
      </div>
      <div className="rounded-md border">
        <GitDiffPanel patch={diff.patch} />
      </div>
    </div>
  );
}
