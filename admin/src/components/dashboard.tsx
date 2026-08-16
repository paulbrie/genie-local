"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { useSubject } from "subjecto/react";
import { toast } from "sonner";

import { ProjectCard } from "@/components/project-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rescanAllAction } from "@/app/actions";
import { BASE_PATH } from "@/lib/config";
import { formatBytes } from "@/lib/format";
import { appServerMemBytes, isAppServerRunning } from "@/lib/run-slug";
import type { ProjectSignals } from "@/lib/types";
import { search, viewMode } from "@/store/ui";

const STATUS_POLL_MS = 5000;

export function Dashboard({
  projects,
  initialRunning,
  initialMemory,
}: {
  projects: ProjectSignals[];
  initialRunning: string[];
  initialMemory: Record<string, number>;
}) {
  const [query, setQuery] = useSubject(search);
  const [mode, setMode] = useSubject(viewMode);
  const [isPending, startTransition] = useTransition();
  const [running, setRunning] = useState<Set<string>>(
    () => new Set(initialRunning),
  );
  const [memory, setMemory] = useState<Record<string, number>>(
    () => initialMemory,
  );

  // Live-poll which apps are running (and their memory) so the status dots and
  // per-project memory readout stay current.
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/run-status`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data: { running: string[]; memory?: Record<string, number> } =
          await res.json();
        if (active) {
          setRunning(new Set(data.running));
          setMemory(data.memory ?? {});
        }
      } catch {
        /* keep last known */
      }
    };
    const id = setInterval(load, STATUS_POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? projects.filter(
        (p) =>
          p.slug.toLowerCase().includes(q) ||
          p.apps.some(
            (a) =>
              a.slug.toLowerCase().includes(q) ||
              (a.name ?? "").toLowerCase().includes(q),
          ),
      )
    : projects;

  function handleRescan() {
    startTransition(async () => {
      try {
        await rescanAllAction();
        toast.success("Rescanned all projects");
      } catch (e) {
        toast.error(
          `Rescan failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter projects…"
          className="max-w-xs"
        />
        <div className="flex items-center gap-1">
          <Button
            variant={mode === "grid" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("grid")}
          >
            Grid
          </Button>
          <Button
            variant={mode === "list" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("list")}
          >
            List
          </Button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {filtered.length} / {projects.length}
          </span>
          <Button size="sm" onClick={handleRescan} disabled={isPending}>
            {isPending ? "Rescanning…" : "Rescan all"}
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No projects match “{query}”.
        </p>
      ) : mode === "grid" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <ProjectCard
              key={p.slug}
              project={p}
              running={running}
              memory={memory}
            />
          ))}
        </div>
      ) : (
        <ProjectList projects={filtered} running={running} memory={memory} />
      )}
    </div>
  );
}

function ProjectList({
  projects,
  running,
  memory,
}: {
  projects: ProjectSignals[];
  running: Set<string>;
  memory: Record<string, number>;
}) {
  return (
    <div className="divide-y rounded-md border">
      {projects.map((p) => {
        const dirty = p.apps.filter((a) => a.git.dirty === true).length;
        const runningCount = p.apps.filter((a) =>
          isAppServerRunning(running, p.slug, a.slug),
        ).length;
        const memBytes = p.apps.reduce(
          (sum, a) => sum + appServerMemBytes(memory, p.slug, a.slug),
          0,
        );
        const appNames = p.apps
          .map((a) => a.name ?? (a.slug === "" ? "(root)" : a.slug))
          .join(", ");
        return (
          <Link
            key={p.slug}
            href={`/projects/${p.slug}`}
            className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted/50"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className={`inline-block size-2 shrink-0 rounded-full ${
                  runningCount > 0
                    ? "bg-emerald-500"
                    : "bg-muted-foreground/30"
                }`}
                title={
                  runningCount > 0 ? `${runningCount} running` : "none running"
                }
              />
              <div className="min-w-0">
                <div className="truncate font-medium">{p.slug}</div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {appNames || "no apps"}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
              {runningCount > 0 && (
                <span className="font-medium text-emerald-600">
                  {runningCount} running
                </span>
              )}
              {memBytes > 0 && (
                <span className="font-mono" title="Resident memory of running apps">
                  {formatBytes(memBytes)}
                </span>
              )}
              <span>
                {p.apps.length} {p.apps.length === 1 ? "app" : "apps"}
              </span>
              {dirty > 0 && <span className="text-destructive">{dirty} dirty</span>}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
