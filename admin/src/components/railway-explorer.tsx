"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  RefreshCw,
  Server,
  Sparkles,
  TrainFront,
} from "lucide-react";
import { toast } from "sonner";

import { runAgentAction } from "@/app/actions";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { BASE_PATH } from "@/lib/config";
import type {
  RailwayDeployment,
  RailwayLogLine,
  RailwayProject,
} from "@/lib/railway";
import { openRun, upsertActiveRun } from "@/store/runs";

// The `logs` input is capped in the agent action (50k chars); keep a little
// headroom and send the most-recent tail when a batch is larger than that.
const MAX_LOG_CHARS = 48_000;
const SEVERITIES = ["all", "info", "warn", "error"] as const;
type Severity = (typeof SEVERITIES)[number];

type ProjectsResponse = {
  configured: boolean;
  projects: RailwayProject[];
  error?: string;
};

type Selection = {
  project: RailwayProject;
  service: { id: string; name: string };
  environmentId: string;
};

export function RailwayExplorer() {
  const [data, setData] = useState<ProjectsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Selection | null>(null);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/railway/projects`, {
        cache: "no-store",
      });
      const json: ProjectsResponse = await res.json();
      setData(json);
      setError(res.ok ? (json.error ?? null) : (json.error ?? `HTTP ${res.status}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const projects = useMemo(() => {
    const list = data?.projects ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.services.some((s) => s.name.toLowerCase().includes(q)),
    );
  }, [data, query]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectService = (
    project: RailwayProject,
    service: { id: string; name: string },
  ) => {
    const environmentId = project.environments[0]?.id ?? "";
    setSel({ project, service, environmentId });
  };

  const notConfigured = data && !data.configured;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter projects & services…"
          className="max-w-xs"
        />
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => void loadProjects()}
          disabled={loading}
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
        <span className="ml-auto text-sm text-muted-foreground">
          {notConfigured
            ? "not configured"
            : error
              ? `railway error — ${error}`
              : data
                ? `${data.projects.length} projects`
                : "loading…"}
        </span>
      </div>

      {notConfigured && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">Railway isn&rsquo;t connected.</p>
          <p className="mt-1 text-muted-foreground">
            Set an account-scoped <code>RAILWAY_API_TOKEN</code> in{" "}
            <code>admin/.env.local</code> and restart the admin service. Create a
            token at railway.com/account/tokens with the Workspace field left
            blank.
          </p>
        </div>
      )}

      {!notConfigured && (
        <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[minmax(16rem,22rem)_1fr]">
          {/* Projects → services tree */}
          <div className="min-h-0 overflow-y-auto rounded-md border">
            {projects.length === 0 ? (
              <p className="p-4 text-center text-sm text-muted-foreground">
                {loading ? "loading…" : "No projects."}
              </p>
            ) : (
              <ul className="divide-y">
                {projects.map((p) => {
                  const isOpen = expanded.has(p.id);
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => toggle(p.id)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50"
                      >
                        <ChevronRight
                          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
                            isOpen ? "rotate-90" : ""
                          }`}
                        />
                        <TrainFront className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate font-medium" title={p.name}>
                          {p.name}
                        </span>
                        <Badge variant="secondary" className="ml-auto shrink-0">
                          {p.services.length}
                        </Badge>
                      </button>
                      {isOpen && (
                        <ul className="pb-1">
                          {p.services.length === 0 ? (
                            <li className="px-3 py-1 pl-9 text-xs text-muted-foreground">
                              No services.
                            </li>
                          ) : (
                            p.services.map((s) => {
                              const active =
                                sel?.service.id === s.id &&
                                sel?.project.id === p.id;
                              return (
                                <li key={s.id}>
                                  <button
                                    type="button"
                                    onClick={() => selectService(p, s)}
                                    className={`flex w-full items-center gap-2 py-1.5 pr-3 pl-9 text-left text-sm transition-colors ${
                                      active
                                        ? "bg-accent font-medium text-accent-foreground"
                                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                                    }`}
                                  >
                                    <Server className="size-3.5 shrink-0" />
                                    <span className="truncate" title={s.name}>
                                      {s.name}
                                    </span>
                                  </button>
                                </li>
                              );
                            })
                          )}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Logs pane */}
          <div className="min-h-0">
            {sel ? (
              <LogsPane
                key={`${sel.project.id}:${sel.service.id}`}
                selection={sel}
                onEnvironmentChange={(environmentId) =>
                  setSel((s) => (s ? { ...s, environmentId } : s))
                }
              />
            ) : (
              <div className="flex h-full items-center justify-center rounded-md border text-sm text-muted-foreground">
                Select a service to view its logs.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function LogsPane({
  selection,
  onEnvironmentChange,
}: {
  selection: Selection;
  onEnvironmentChange: (environmentId: string) => void;
}) {
  const { project, service, environmentId } = selection;
  const [deployments, setDeployments] = useState<RailwayDeployment[] | null>(null);
  const [deploymentId, setDeploymentId] = useState<string>("");
  const [logs, setLogs] = useState<RailwayLogLine[] | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [severity, setSeverity] = useState<Severity>("all");
  const [discoverOpen, setDiscoverOpen] = useState(false);

  // Load deployments whenever the service or environment changes; auto-pick the
  // newest deployment as the active one.
  useEffect(() => {
    if (!environmentId) {
      setDeployments([]);
      return;
    }
    let active = true;
    setDeployments(null);
    setErr(null);
    (async () => {
      try {
        const res = await fetch(
          `${BASE_PATH}/api/railway/deployments?environmentId=${encodeURIComponent(
            environmentId,
          )}&serviceId=${encodeURIComponent(service.id)}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!active) return;
        if (!res.ok) {
          setErr(json.error ?? `HTTP ${res.status}`);
          setDeployments([]);
          return;
        }
        const list: RailwayDeployment[] = json.deployments ?? [];
        setDeployments(list);
        setDeploymentId(list[0]?.id ?? "");
      } catch (e) {
        if (active) setErr((e as Error).message);
      }
    })();
    return () => {
      active = false;
    };
  }, [environmentId, service.id]);

  const loadLogs = useCallback(async () => {
    if (!deploymentId) return;
    setLoadingLogs(true);
    setErr(null);
    try {
      const res = await fetch(
        `${BASE_PATH}/api/railway/logs?deploymentId=${encodeURIComponent(
          deploymentId,
        )}&limit=1000`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok) {
        setErr(json.error ?? `HTTP ${res.status}`);
        setLogs([]);
        return;
      }
      setLogs(json.logs ?? []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoadingLogs(false);
    }
  }, [deploymentId]);

  useEffect(() => {
    if (deploymentId) void loadLogs();
    else setLogs(null);
  }, [deploymentId, loadLogs]);

  const filtered = useMemo(() => {
    const list = logs ?? [];
    const q = text.trim().toLowerCase();
    return list.filter((l) => {
      if (severity !== "all" && !matchesSeverity(l, severity)) return false;
      if (q && !l.message.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [logs, text, severity]);

  const logText = useMemo(
    () =>
      filtered
        .map((l) => `${l.timestamp} ${l.severity ? `[${l.severity}] ` : ""}${l.message}`)
        .join("\n"),
    [filtered],
  );

  return (
    <div className="flex h-full min-h-0 flex-col rounded-md border">
      {/* Header: what we're looking at */}
      <div className="flex flex-wrap items-center gap-2 border-b p-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium" title={`${project.name} / ${service.name}`}>
            {project.name} <span className="text-muted-foreground">/</span>{" "}
            {service.name}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {project.environments.length > 1 && (
            <Select
              value={environmentId}
              onValueChange={(v) => v && onEnvironmentChange(v)}
            >
              <SelectTrigger size="sm" className="h-8 w-[10rem]">
                <SelectValue placeholder="environment" />
              </SelectTrigger>
              <SelectContent>
                {project.environments.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select
            value={deploymentId}
            onValueChange={(v) => v && setDeploymentId(v)}
            disabled={!deployments || deployments.length === 0}
          >
            <SelectTrigger size="sm" className="h-8 w-[16rem]">
              <SelectValue
                placeholder={deployments == null ? "loading…" : "no deployments"}
              />
            </SelectTrigger>
            <SelectContent>
              {(deployments ?? []).map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  <span className="font-mono text-xs">{d.id.slice(0, 8)}</span>
                  {" · "}
                  {d.status}
                  {" · "}
                  {new Date(d.createdAt).toLocaleString()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={() => void loadLogs()}
            disabled={loadingLogs || !deploymentId}
          >
            <RefreshCw className={`size-3.5 ${loadingLogs ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 border-b p-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Filter log lines…"
          className="h-8 max-w-xs"
        />
        <Select value={severity} onValueChange={(v) => v && setSeverity(v as Severity)}>
          <SelectTrigger size="sm" className="h-8 w-[8rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SEVERITIES.map((s) => (
              <SelectItem key={s} value={s}>
                {s === "all" ? "all levels" : s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">
          {logs ? `${filtered.length}/${logs.length} lines` : ""}
        </span>
        <Button
          size="sm"
          className="ml-auto h-8 gap-1.5"
          disabled={filtered.length === 0}
          onClick={() => setDiscoverOpen(true)}
        >
          <Sparkles className="size-3.5" />
          Discover with agent
        </Button>
      </div>

      {/* Log body */}
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed">
        {err
          ? `Error: ${err}`
          : loadingLogs && !logs
            ? "loading…"
            : filtered.length === 0
              ? logs
                ? "(no matching log lines)"
                : "(select a deployment)"
              : filtered.map((l, i) => <LogRow key={i} line={l} />)}
      </pre>

      <DiscoverDialog
        open={discoverOpen}
        onOpenChange={setDiscoverOpen}
        service={`${project.name} / ${service.name}`}
        logText={logText}
        lineCount={filtered.length}
      />
    </div>
  );
}

function LogRow({ line }: { line: RailwayLogLine }) {
  const color = severityColor(line.severity);
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-muted-foreground/60">
        {formatTs(line.timestamp)}
      </span>
      <span className={color}>{line.message}</span>
    </div>
  );
}

function DiscoverDialog({
  open,
  onOpenChange,
  service,
  logText,
  lineCount,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  service: string;
  logText: string;
  lineCount: number;
}) {
  const [question, setQuestion] = useState("");
  const [starting, setStarting] = useState(false);

  // Send the most-recent tail if the batch exceeds the input cap.
  const truncated = logText.length > MAX_LOG_CHARS;
  const payload = truncated ? logText.slice(-MAX_LOG_CHARS) : logText;

  async function start() {
    setStarting(true);
    try {
      const runId = await runAgentAction("railway-discovery", {
        service,
        logs: payload,
        question: question.trim() || "What is going on in these logs? Summarize the health of the service and surface anything worth investigating.",
      });
      upsertActiveRun({
        runId,
        kind: "agent",
        slug: "railway-discovery",
        name: "Railway Discovery",
        logFile: "",
        state: "starting",
        running: true,
        stepsDone: 0,
        stepsTotal: 1,
        startedAt: new Date().toISOString(),
        endedAt: null,
      });
      openRun(runId);
      onOpenChange(false);
      setQuestion("");
      toast.success("Railway Discovery: started");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Discover with agent</DialogTitle>
          <DialogDescription>
            Hand the {lineCount} filtered log line{lineCount === 1 ? "" : "s"} from{" "}
            <span className="font-mono">{service}</span> to the{" "}
            <span className="font-mono">railway-discovery</span> agent. It runs in
            the background and streams into the run console.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="discover-q" className="text-xs">
              Question (optional)
            </Label>
            <Textarea
              id="discover-q"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={3}
              placeholder="e.g. Why is this service restarting? Any errors in the last hour?"
              autoFocus
            />
          </div>
          {truncated && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              The batch is large — only the most recent{" "}
              {Math.round(MAX_LOG_CHARS / 1000)}k characters will be sent.
            </p>
          )}
        </div>
        <DialogFooter showCloseButton>
          <Button size="sm" onClick={start} disabled={starting || !payload}>
            {starting ? "Starting…" : "Run discovery"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function matchesSeverity(line: RailwayLogLine, sev: Severity): boolean {
  const s = (line.severity ?? "").toLowerCase();
  switch (sev) {
    case "error":
      return s.startsWith("err") || s === "fatal" || s === "critical";
    case "warn":
      return s.startsWith("warn");
    case "info":
      // "info" bucket = everything that isn't a warning or an error.
      return !s.startsWith("err") && !s.startsWith("warn") && s !== "fatal" && s !== "critical";
    default:
      return true;
  }
}

const SEVERITY_COLOR: Record<string, string> = {
  err: "text-red-500",
  error: "text-red-500",
  fatal: "text-red-500",
  critical: "text-red-500",
  warn: "text-amber-500",
  warning: "text-amber-500",
};

function severityColor(severity: string | null): string {
  if (!severity) return "";
  return SEVERITY_COLOR[severity.toLowerCase()] ?? "";
}

function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString();
}
