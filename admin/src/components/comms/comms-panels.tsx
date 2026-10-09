"use client";

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import type { CommitInfo, CommsTask, FileClaim, TaskState } from "@/lib/claude-comms-parse";
import { formatRelativeTime } from "@/lib/format";

import type { NodeView } from "./comms-view";

type ByKey = Map<string, NodeView>;

function Who({ k, byKey }: { k: string | null; byKey: ByKey }) {
  if (!k) return <span className="text-muted-foreground">free</span>;
  const n = byKey.get(k);
  return (
    <span className="inline-flex items-center gap-1">
      <span className="size-2 rounded-full" style={{ background: n?.color ?? "gray" }} />
      {n?.name ?? "?"}
    </span>
  );
}

const STATE_LABEL: Record<TaskState, string> = {
  dispatched: "dispatched",
  in_progress: "in progress",
  blocked: "blocked",
  done: "done",
};
const STATE_CLASS: Record<TaskState, string> = {
  dispatched: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  in_progress: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  blocked: "bg-destructive/15 text-destructive",
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
};
const STATE_ORDER: TaskState[] = ["blocked", "in_progress", "dispatched", "done"];

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="rounded-md border p-3 text-sm text-muted-foreground">{children}</p>
);

export function TasksPanel({
  tasks,
  byKey,
  onHighlight,
  onOpen,
}: {
  tasks: CommsTask[];
  byKey: ByKey;
  onHighlight: (msgIds: string[]) => void;
  onOpen: (msgId: string) => void;
}) {
  if (tasks.length === 0) return <Empty>No tasks found in these messages.</Empty>;
  const sorted = [...tasks].sort(
    (a, b) =>
      STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) ||
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );
  return (
    <ul className="max-h-[70vh] space-y-2 overflow-auto">
      {sorted.map((t) => (
        <li key={t.key} className="rounded-md border p-2.5 text-sm">
          <div className="flex items-start gap-2">
            {t.id && <Badge variant="outline" className="font-mono">{t.id}</Badge>}
            <button
              type="button"
              className="min-w-0 flex-1 text-left font-medium hover:underline"
              onClick={() => onHighlight(t.history.map((h) => h.msgId))}
              title="Highlight this task's messages in the diagram"
            >
              <span className="line-clamp-2">{t.title}</span>
            </button>
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${STATE_CLASS[t.state]}`}>
              {STATE_LABEL[t.state]}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Who k={t.manager} byKey={byKey} /> → <Who k={t.worker} byKey={byKey} />
            <span>· {formatRelativeTime(t.updatedAt)}</span>
            {t.guessed && (
              <Badge variant="outline" className="h-4 px-1 text-[10px]">guessed</Badge>
            )}
          </div>
          {t.lastText && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{t.lastText}</p>
          )}
          <ol className="mt-1.5 flex flex-wrap gap-1">
            {t.history.map((h, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => onOpen(h.msgId)}
                  className={`rounded px-1 text-[10px] ${STATE_CLASS[h.state]}`}
                  title={h.text ?? undefined}
                >
                  {STATE_LABEL[h.state]}
                </button>
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ul>
  );
}

export function FilesPanel({
  files,
  byKey,
  onOpen,
}: {
  files: FileClaim[];
  byKey: ByKey;
  onOpen: (msgId: string) => void;
}) {
  if (files.length === 0) return <Empty>No file claims or releases found.</Empty>;
  const held = files.filter((f) => f.holder);
  const free = files.filter((f) => !f.holder);
  return (
    <div className="max-h-[70vh] space-y-3 overflow-auto">
      {[
        { title: `Held (${held.length})`, list: held },
        { title: `Released (${free.length})`, list: free },
      ].map(
        (g) =>
          g.list.length > 0 && (
            <section key={g.title}>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">{g.title}</h3>
              <ul className="divide-y rounded-md border">
                {g.list.map((f) => (
                  <li key={f.path} className="p-2 text-xs">
                    <details>
                      <summary className="flex cursor-pointer items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-mono" title={f.path}>
                          {f.path}
                        </span>
                        <Who k={f.holder} byKey={byKey} />
                        {f.guessed && (
                          <Badge variant="outline" className="h-4 px-1 text-[10px]">guessed</Badge>
                        )}
                      </summary>
                      <ol className="mt-1.5 space-y-0.5 pl-2">
                        {f.history.map((h, i) => (
                          <li key={i} className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => onOpen(h.msgId)}
                              className="hover:underline"
                            >
                              {h.action}
                            </button>
                            <Who k={h.node} byKey={byKey} />
                            <span className="text-muted-foreground">
                              {formatRelativeTime(h.at)}
                              {h.guessed ? " · guessed" : ""}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  </li>
                ))}
              </ul>
            </section>
          ),
      )}
    </div>
  );
}

/** Link to the commit in its project's git history, when it's a verified commit of a known project. */
export function commitHref(c: CommitInfo): string | null {
  return c.project != null && c.verified
    ? `/projects/${encodeURIComponent(c.project)}?tab=git&app=${encodeURIComponent(c.app ?? "")}&commit=${c.hash}`
    : null;
}

export function CommitsPanel({
  commits,
  byKey,
  onOpen,
}: {
  commits: CommitInfo[];
  byKey: ByKey;
  onOpen: (msgId: string) => void;
}) {
  if (commits.length === 0) return <Empty>No commits mentioned.</Empty>;
  return (
    <ul className="max-h-[70vh] divide-y overflow-auto rounded-md border">
      {commits.map((c) => {
        const href = commitHref(c);
        const last = c.mentions[c.mentions.length - 1];
        return (
          <li key={`${c.project}:${c.hash}`} className="space-y-1 p-2 text-xs">
            <div className="flex items-center gap-2">
              {href ? (
                <Link href={href} className="font-mono text-primary hover:underline">
                  {c.abbrev}
                </Link>
              ) : (
                <span className="font-mono">{c.abbrev}</span>
              )}
              <span className="min-w-0 flex-1 truncate" title={c.subject ?? undefined}>
                {c.subject ?? <span className="text-muted-foreground">not found in the repo</span>}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
              {c.remotes && c.remotes.length > 0 ? (
                <Badge variant="secondary" className="h-4 px-1 text-[10px]" title={c.remotes.join(", ")}>
                  on {c.remotes[0]}
                  {c.remotes.length > 1 ? ` +${c.remotes.length - 1}` : ""}
                </Badge>
              ) : c.verified ? (
                <Badge variant="outline" className="h-4 px-1 text-[10px]">local only</Badge>
              ) : null}
              {c.pushedTag && <Badge variant="outline" className="h-4 px-1 text-[10px]">PUSHED</Badge>}
              {!c.verified && <Badge variant="destructive" className="h-4 px-1 text-[10px]">unverified</Badge>}
              {c.project && <span className="font-mono">{c.project}{c.app ? `/${c.app}` : ""}</span>}
              {c.author && <span>· {c.author}</span>}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {c.mentions.map((m, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => onOpen(m.msgId)}
                  className="inline-flex items-center gap-1 rounded border px-1 text-[10px] hover:bg-muted"
                  title={`${m.kind} · ${formatRelativeTime(m.at)}`}
                >
                  <Who k={m.node} byKey={byKey} /> {m.kind}
                </button>
              ))}
              {last && <span className="text-[10px] text-muted-foreground">{formatRelativeTime(last.at)}</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
