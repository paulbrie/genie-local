"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { closeTeamAction, restartMemberAction, startTeamAction, stopTeamAction } from "@/app/teams/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusDot } from "@/components/ui/status-dot";
import { BASE_PATH } from "@/lib/config";
import type { StepResult } from "@/lib/teams";

const POLL_MS = 3000;

type MemberView = {
  name: string;
  role: string;
  cwd: string;
  model: string;
  effort: string;
  permissionMode: string;
  permissionInfo: { tone: "warn" | "neutral"; text: string };
  allowedTools: string[];
  promptFile: string;
  promptPreview: string;
};
type MemberState = {
  name: string;
  running: boolean;
  exited: boolean;
  status: string | null;
  target: string | null;
  outside: boolean;
  stop: "asked" | "working" | "answered" | "gone" | null;
};
type TeamView = {
  slug: string;
  errors: string[];
  recipe: { slug: string; name: string; description: string; rulesDoc: string | null; lead: string; projects: string[]; members: MemberView[] } | null;
  state: { members: MemberState[]; stopAt: number | null } | null;
  plan: { launching: number; opus: number; skip: string[] } | null;
};

export function TeamsView() {
  const [teams, setTeams] = useState<TeamView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_PATH}/api/teams`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { teams: TeamView[] };
      setTeams(json.teams);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(iv);
    };
  }, [load]);

  if (error) return <p className="text-sm text-destructive">Error: {error}</p>;
  if (!teams) return <p className="text-sm text-muted-foreground">Loading teams…</p>;
  if (teams.length === 0)
    return <p className="text-sm text-muted-foreground">No team recipes found (a folder with a team.json under the teams directory).</p>;
  return (
    <div className="space-y-6">
      {teams.map((t) => (
        <TeamCard key={t.slug} team={t} reload={load} />
      ))}
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = {
  "claude-working": "working",
  "claude-idle": "idle",
  "claude-input": "waiting for input",
  idle: "shell",
  busy: "busy",
};

function TeamCard({ team, reload }: { team: TeamView; reload: () => Promise<void> }) {
  const [dialog, setDialog] = useState<"start" | "stop" | "close" | null>(null);
  const [results, setResults] = useState<{ title: string; results: StepResult[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!team.recipe || !team.state || !team.plan) {
    return (
      <section className="rounded-md border border-destructive/40 p-4">
        <h2 className="font-mono font-semibold">{team.slug}</h2>
        <p className="mt-1 text-sm text-destructive">This recipe can&apos;t be used:</p>
        <ul className="mt-1 list-disc pl-5 text-sm text-destructive">
          {team.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </section>
    );
  }
  const { recipe, state, plan } = team;
  const byName = new Map(state.members.map((m) => [m.name, m]));
  const runningCount = state.members.filter((m) => m.running).length;
  const exitedCount = state.members.filter((m) => m.exited).length;
  const asked = state.stopAt != null;
  const allAnswered = asked && state.members.every((m) => !m.running || m.stop === "answered" || m.stop === "gone" || m.stop === null);

  const run = async (title: string, fn: () => Promise<{ ok: true; results: StepResult[] } | { ok: false; error: string }>) => {
    setBusy(true);
    setActionError(null);
    try {
      const r = await fn();
      if (r.ok) setResults({ title, results: r.results });
      else setActionError(r.error);
    } finally {
      setBusy(false);
      setDialog(null);
      await reload();
    }
  };

  return (
    <section className="rounded-md border p-4">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{recipe.name}</h2>
          <p className="text-sm text-muted-foreground">{recipe.description}</p>
          <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            <span>lead: {recipe.lead}</span>
            {recipe.rulesDoc && (
              <span>
                rules: <code className="font-mono">{recipe.rulesDoc}</code>
              </span>
            )}
            {recipe.projects.length > 0 && (
              <Link href={`/agents3d?projects=${encodeURIComponent(recipe.projects.join(","))}`} className="underline underline-offset-2">
                Agents City (team projects)
              </Link>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setDialog("start")} disabled={busy || plan.launching === 0} title={plan.launching === 0 ? "Every member is running" : undefined}>
            Start team
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDialog("stop")} disabled={busy || runningCount === 0}>
            Stop team
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setDialog("close")}
            disabled={busy || runningCount + exitedCount === 0}
            title={asked ? undefined : "Use Stop team first, so members can commit their work"}
          >
            Close sessions
          </Button>
        </div>
      </header>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-1 pr-3">Member</th>
              <th className="py-1 pr-3">Model</th>
              <th className="py-1 pr-3">Permission mode</th>
              <th className="py-1 pr-3">Working dir</th>
              <th className="py-1 pr-3">State</th>
              {asked && <th className="py-1 pr-3">Stop request</th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {recipe.members.map((m) => {
              const s = byName.get(m.name);
              return (
                <tr key={m.name} className="align-top">
                  <td className="py-1.5 pr-3">
                    <div className="font-medium">
                      {m.name} {m.name === recipe.lead && <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">lead</Badge>}
                    </div>
                    <div className="max-w-72 text-xs text-muted-foreground">{m.role}</div>
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-xs">
                    {m.model} · {m.effort}
                  </td>
                  <td className="py-1.5 pr-3">
                    <PermissionBadge mode={m.permissionMode} info={m.permissionInfo} />
                    {m.allowedTools.length > 0 && (
                      <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">tools: {m.allowedTools.join(", ")}</div>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-xs">{m.cwd}</td>
                  <td className="py-1.5 pr-3 text-xs">
                    <MemberStateCell s={s} />
                    {s?.exited && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="ml-2 h-6 px-2 text-xs"
                        disabled={busy}
                        onClick={() => run(`Restart ${m.name}`, () => restartMemberAction(recipe.slug, m.name))}
                      >
                        Restart
                      </Button>
                    )}
                  </td>
                  {asked && <td className="py-1.5 pr-3 text-xs">{s?.stop ?? "—"}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {actionError && <p className="mt-2 text-sm text-destructive">{actionError}</p>}
      {results && (
        <div className="mt-3 rounded border bg-muted/30 p-2 text-xs">
          <div className="mb-1 font-medium">{results.title}</div>
          <ul>
            {results.results.map((r) => (
              <li key={r.name} className={r.ok ? "" : "text-destructive"}>
                {r.name}: {r.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Start: exactly what will be launched. */}
      <Dialog open={dialog === "start"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Start {recipe.name}</DialogTitle>
            <DialogDescription>
              Launches {plan.launching} Claude Code session{plan.launching === 1 ? "" : "s"} ({plan.opus} on Opus), lead first, each in its own
              admin-&lt;Name&gt; tmux session, with its first prompt. Members already running are skipped.
            </DialogDescription>
            <p className="text-xs text-muted-foreground">
              A working dir Claude Code hasn&apos;t opened before asks &quot;Do you trust this folder?&quot; on first launch: the member shows as
              waiting for input until you answer it in its terminal.
            </p>
          </DialogHeader>
          <ul className="max-h-[50vh] space-y-2 overflow-auto text-sm">
            {recipe.members.map((m) => {
              const skip = plan.skip.includes(m.name);
              return (
                <li key={m.name} className={`rounded border p-2 ${skip ? "opacity-50" : ""}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{m.name}</span>
                    {skip && <Badge variant="outline" className="h-4 px-1 text-[10px]">already running: skip</Badge>}
                    <code className="font-mono text-xs">
                      --model {m.model} --effort {m.effort}
                    </code>
                    <PermissionBadge mode={m.permissionMode} info={m.permissionInfo} />
                  </div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {m.cwd}
                    {m.allowedTools.length > 0 && ` · tools: ${m.allowedTools.join(", ")}`}
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap rounded bg-muted/40 p-1.5 text-[11px]">{m.promptPreview}…</pre>
                </li>
              );
            })}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button disabled={busy || plan.launching === 0} onClick={() => run(`Start ${recipe.name}`, () => startTeamAction(recipe.slug))}>
              {busy ? "Starting…" : `Start ${plan.launching} session${plan.launching === 1 ? "" : "s"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Stop: ask everyone to commit or write a STATUS. */}
      <Dialog open={dialog === "stop"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Stop {recipe.name}</DialogTitle>
            <DialogDescription>
              Types a message into each running member&apos;s Claude input asking it to commit its work or write a STATUS of what&apos;s left. Nothing is
              closed yet: the card shows who has answered, then you can close the sessions.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => run(`Stop ${recipe.name}`, () => stopTeamAction(recipe.slug))}>
              Ask {runningCount} member{runningCount === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Close: kill this team's sessions only. */}
      <Dialog open={dialog === "close"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Close {recipe.name}&apos;s sessions</DialogTitle>
            <DialogDescription>
              Kills the tmux sessions {state.members.filter((m) => m.target).map((m) => m.target).join(", ")}{" "}
              and nothing else. Anything not committed in them is lost.
            </DialogDescription>
          </DialogHeader>
          {!allAnswered && (
            <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-700 dark:text-amber-300">
              {asked ? "Not every member has answered the stop request yet." : "You haven't asked the members to commit first (Stop team)."}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => run(`Close ${recipe.name}`, () => closeTeamAction(recipe.slug))}>
              Close sessions
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function PermissionBadge({ mode, info }: { mode: string; info: { tone: "warn" | "neutral"; text: string } }) {
  return (
    <span
      title={info.text}
      className={`inline-flex h-5 items-center rounded px-1.5 font-mono text-[11px] font-semibold ${
        info.tone === "warn" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-muted text-muted-foreground"
      }`}
    >
      {mode}
    </span>
  );
}

function MemberStateCell({ s }: { s: MemberState | undefined }) {
  if (!s || (!s.running && !s.exited)) return <span className="text-muted-foreground">not running</span>;
  if (s.outside) return <span className="text-muted-foreground">running outside the admin&apos;s terminals</span>;
  if (s.exited)
    return (
      <span className="inline-flex items-center gap-1 text-destructive">
        <StatusDot color="bg-red-500" /> exited ({s.target})
      </span>
    );
  const working = s.status === "claude-working";
  return (
    <span className="inline-flex items-center gap-1">
      <StatusDot color={working ? "bg-amber-500" : s.status === "claude-input" ? "bg-sky-500" : "bg-emerald-500"} pulse={working} />
      {STATUS_TEXT[s.status ?? ""] ?? s.status} <span className="text-muted-foreground">({s.target})</span>
    </span>
  );
}
