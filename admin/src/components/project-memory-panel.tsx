"use client";

import { Fragment, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import {
  Bot,
  Box,
  ChevronRight,
  Container,
  SquareTerminal,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";
import { useSubject } from "subjecto/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BASE_PATH } from "@/lib/config";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import type { MemoryGroup } from "@/lib/project-memory";
import type { HistoryRange, ProjectMemoryHistory } from "@/lib/stats-history";
import { cn } from "@/lib/utils";
import { memoryOf, projectMemory } from "@/store/project-memory";
import { openTerminal } from "@/store/terminals";

const ProjectMemoryChart = dynamic(() => import("./project-memory-chart"), {
  ssr: false,
  loading: () => <div className="h-52" />,
});

const RANGES: { value: HistoryRange; label: string }[] = [
  { value: "1d", label: "24 h" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

const KIND: Record<MemoryGroup["kind"], { icon: typeof Box; label: string }> = {
  script: { icon: Terminal, label: "Script" },
  process: { icon: Box, label: "Process" },
  container: { icon: Container, label: "Container" },
  agent: { icon: Bot, label: "Agent" },
};

/**
 * A project's memory (/projects/<slug>/memory): what it runs now, script by
 * script, its containers and its agents apart (live, from store/project-memory);
 * the limit to warn above; and the last day, week or month.
 */
export function ProjectMemoryPanel({ slug }: { slug: string }) {
  const [status] = useSubject(projectMemory);
  const mem = memoryOf(status, slug);
  const limitMb = status?.limits[slug] ?? null;
  const limitBytes = limitMb != null ? limitMb * 1024 * 1024 : null;

  // the row opened to its processes
  const [opened, setOpened] = useState<string | null>(null);
  const [range, setRange] = useState<HistoryRange>("1d");
  const [history, setHistory] = useState<ProjectMemoryHistory | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch(
        `${BASE_PATH}/api/project-memory/history?slug=${encodeURIComponent(slug)}&range=${range}`,
        { cache: "no-store" },
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((h) => live && h && setHistory(h))
        .catch(() => {});
    void load();
    // (a sample a minute)
    const id = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [slug, range]);

  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the field follows the saved limit until edited
    setDraft(
      limitMb != null ? String(Math.round((limitMb / 1024) * 10) / 10) : "",
    );
  }, [limitMb]);
  const saveLimit = async (gb: number | null) => {
    setSaving(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/project-memory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          limitMb: gb == null ? null : Math.round(gb * 1024),
        }),
      });
      if (!res.ok)
        throw new Error(
          (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`,
        );
      // (the next reading carries it; until then, show it here)
      if (status)
        projectMemory.next({
          ...status,
          limits:
            gb == null
              ? omit(status.limits, slug)
              : { ...status.limits, [slug]: Math.round(gb * 1024) },
        });
      toast.success(gb == null ? "Limit removed" : `Warns above ${gb} GB`);
    } catch (e) {
      toast.error(`Couldn't save the limit: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const groups = mem?.groups ?? [];
  const over = mem && limitBytes != null && mem.bytes > limitBytes;
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="text-lg font-semibold">
            {status ? (mem ? formatBytes(mem.bytes) : "Nothing running") : "…"}
          </h2>
          {mem && mem.agentBytes > 0 && (
            <span className="text-sm text-muted-foreground">
              + {formatBytes(mem.agentBytes)} for its agents (Claude sessions),
              not counted
            </span>
          )}
          {over && (
            <span className="text-sm font-medium text-destructive">
              over its {formatBytes(limitBytes!)} limit
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Every process running in this project&apos;s folder, whoever started
          it, and its Docker containers. Shared memory is split between the
          processes that share it (PSS), so the figures add up to what&apos;s
          really in use.
        </p>
        {groups.length > 0 && (
          <table className="w-full text-sm" data-testid="project-memory-table">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1 font-normal">What</th>
                <th className="py-1 font-normal">Where</th>
                <th className="py-1 text-right font-normal">Processes</th>
                <th className="py-1 text-right font-normal">Memory</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const K = KIND[g.kind];
                const isOpen = opened === g.key;
                // (an agent says where it runs: its terminal, or outside them, e.g. a background session)
                const where = g.terminal
                  ? g.terminal
                  : g.kind === "agent"
                    ? "not in a terminal"
                    : null;
                return (
                  <Fragment key={g.key}>
                    <tr
                      className={cn(
                        "cursor-pointer border-t hover:bg-muted/50",
                        g.kind === "agent" && "text-muted-foreground",
                        isOpen && "bg-muted/40",
                      )}
                      onClick={() => setOpened(isOpen ? null : g.key)}
                      aria-expanded={isOpen}
                      data-testid={`memory-row-${g.key}`}
                    >
                      <td className="py-1">
                        <span
                          className="flex items-center gap-2"
                          title={K.label}
                        >
                          <ChevronRight
                            className={cn(
                              "size-3 shrink-0 transition-transform",
                              isOpen && "rotate-90",
                            )}
                          />
                          <K.icon className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="font-mono text-xs">{g.label}</span>
                          {where && (
                            <span className="truncate text-xs text-muted-foreground">
                              · {where}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="py-1 text-xs text-muted-foreground">
                        {g.app || "—"}
                      </td>
                      <td className="py-1 text-right tabular-nums">
                        {g.pids.length || "—"}
                      </td>
                      <td
                        className="py-1 text-right font-mono tabular-nums"
                        title={
                          g.estimated
                            ? "Resident memory: its share of shared memory couldn't be read, so this is a little high"
                            : undefined
                        }
                      >
                        {g.estimated ? "≈ " : ""}
                        {formatBytes(g.bytes)}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-muted/20">
                        <td colSpan={4} className="px-2 pt-1 pb-2">
                          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                            {g.terminal ? (
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() => openTerminal(g.terminal!)}
                                data-testid="memory-open-terminal"
                              >
                                <SquareTerminal /> Open the terminal “
                                {g.terminal}”
                              </Button>
                            ) : g.kind === "agent" ? (
                              <span className="text-muted-foreground">
                                A Claude session started outside the
                                admin&apos;s terminals (a background session, or
                                one from SSH): it runs in this project&apos;s
                                folder, so it counts here.
                              </span>
                            ) : g.kind === "container" ? (
                              <span className="text-muted-foreground">
                                A Docker container of this project&apos;s
                                compose file: see Docker.
                              </span>
                            ) : null}
                          </div>
                          {g.procs.length > 0 && (
                            <table
                              className="w-full text-xs"
                              data-testid="memory-procs"
                            >
                              <thead className="text-left text-muted-foreground">
                                <tr>
                                  <th className="py-0.5 font-normal">pid</th>
                                  <th className="w-full py-0.5 font-normal">
                                    Command
                                  </th>
                                  <th className="py-0.5 font-normal">
                                    Started
                                  </th>
                                  <th className="py-0.5 text-right font-normal">
                                    Memory
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {g.procs.map((p) => (
                                  <tr
                                    key={p.pid}
                                    className="border-t border-border/50 align-top"
                                  >
                                    <td className="py-0.5 pr-2 font-mono tabular-nums">
                                      {p.pid}
                                    </td>
                                    <td className="max-w-0 py-0.5 pr-2 font-mono">
                                      <span
                                        className="block truncate"
                                        title={`${p.command}\nin ${p.cwd}`}
                                      >
                                        {p.command}
                                      </span>
                                    </td>
                                    <td
                                      className="py-0.5 pr-2 whitespace-nowrap text-muted-foreground"
                                      title={
                                        p.startedAt
                                          ? new Date(
                                              p.startedAt,
                                            ).toLocaleString()
                                          : undefined
                                      }
                                    >
                                      {p.startedAt
                                        ? formatRelativeTime(
                                            new Date(p.startedAt),
                                          )
                                        : "—"}
                                    </td>
                                    <td className="py-0.5 text-right font-mono whitespace-nowrap tabular-nums">
                                      {p.estimated ? "≈ " : ""}
                                      {formatBytes(p.bytes)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Limit</h3>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const gb = Number(draft.replace(",", "."));
            if (!(gb > 0)) {
              toast.error("A size in GB, like 4 or 1.5");
              return;
            }
            void saveLimit(gb);
          }}
        >
          <Input
            aria-label="Limit in GB"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. 4"
            className="h-8 w-24"
            inputMode="decimal"
          />
          <span className="text-sm text-muted-foreground">GB</span>
          <Button size="sm" type="submit" disabled={saving}>
            Save
          </Button>
          {limitMb != null && (
            <Button
              size="sm"
              variant="ghost"
              type="button"
              disabled={saving}
              onClick={() => saveLimit(null)}
            >
              Remove
            </Button>
          )}
        </form>
        <p className="text-xs text-muted-foreground">
          Past it, every open admin warns (and says so out loud when voice
          alerts are on); again only once it has come back under. The admin also
          warns when the whole server has less than 10% of its memory left.
        </p>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">History</h3>
          <Tabs
            value={range}
            onValueChange={(v) => setRange(v as HistoryRange)}
          >
            <TabsList>
              {RANGES.map((r) => (
                <TabsTrigger key={r.value} value={r.value}>
                  {r.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        {!history ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Loading…
          </p>
        ) : history.points.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No history yet: a sample is taken every minute.
          </p>
        ) : (
          <ProjectMemoryChart
            range={range}
            points={history.points}
            limitBytes={limitBytes}
          />
        )}
      </section>
    </div>
  );
}

function omit<T>(o: Record<string, T>, k: string): Record<string, T> {
  const { [k]: _, ...rest } = o;
  void _;
  return rest;
}
