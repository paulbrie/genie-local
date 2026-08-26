"use client";

import { useState, useTransition } from "react";
import { Eye, Play, SquareTerminal } from "lucide-react";
import { toast } from "sonner";
import { useSubject } from "subjecto/react";

import {
  previewRunAction,
  type PromptPreview,
  runAgentAction,
  runPipelineAction,
} from "@/app/actions";
import type { RunConfig } from "@/lib/agent-run-types";
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
import { StatusDot } from "@/components/ui/status-dot";
import { Textarea } from "@/components/ui/textarea";
import { activeRuns, openRun, upsertActiveRun } from "@/store/runs";

type Kind = "agent" | "pipeline";

const SELECT_CLS =
  "h-8 rounded-md border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";
const PERMISSION_MODE_OPTS = ["plan", "acceptEdits", "bypassPermissions"] as const;

type OverrideState = {
  permissionMode: string;
  maxTurns: string;
  timeoutSec: string;
};
const EMPTY_OVERRIDES: OverrideState = {
  permissionMode: "",
  maxTurns: "",
  timeoutSec: "",
};

/** Turn the dialog's override fields into a RunConfig (or undefined if empty). */
function toConfig(o: OverrideState): RunConfig | undefined {
  const cfg: RunConfig = {};
  if (o.permissionMode) cfg.permissionMode = o.permissionMode as RunConfig["permissionMode"];
  if (o.maxTurns.trim()) cfg.maxTurns = Number(o.maxTurns);
  if (o.timeoutSec.trim()) cfg.timeoutSec = Number(o.timeoutSec);
  return Object.keys(cfg).length ? cfg : undefined;
}

/**
 * Run controls for one markdown-defined agent or pipeline. Collects the declared
 * `inputs` in a dialog (or fires immediately when there are none), starts a
 * detached run via a server action, and opens it in the global run dock (a
 * movable/resizable window that survives navigation). A live indicator, driven
 * by the shared `activeRuns` subject, shows this card's currently-running count
 * and re-opens the latest run's window.
 */
export function AgentRunControls({
  kind,
  slug,
  name,
  inputs,
}: {
  kind: Kind;
  slug: string;
  name: string;
  inputs: string[];
}) {
  const [runs] = useSubject(activeRuns);
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<OverrideState>(EMPTY_OVERRIDES);
  const [preview, setPreview] = useState<PromptPreview[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [isPending, startTransition] = useTransition();

  const mine = runs.filter((r) => r.kind === kind && r.slug === slug);
  const activeCount = mine.filter(
    (r) =>
      r.running ||
      r.state === "running" ||
      r.state === "starting" ||
      r.state === "queued",
  ).length;
  const latest = mine[0]; // activeRuns is newest-first

  async function doPreview(vals: Record<string, string>) {
    setPreviewing(true);
    try {
      setPreview(await previewRunAction(kind, slug, vals));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  }

  function start(vals: Record<string, string>) {
    startTransition(async () => {
      try {
        const config = toConfig(overrides);
        const runId =
          kind === "agent"
            ? await runAgentAction(slug, vals, config)
            : await runPipelineAction(slug, vals, config);
        setOpen(false);
        // Seed the run optimistically so its window shows a name + running
        // state at once; the dock's poll fills in the rest within seconds.
        upsertActiveRun({
          runId,
          kind,
          slug,
          name,
          logFile: "",
          state: "starting",
          running: true,
          stepsDone: 0,
          stepsTotal: 0,
          startedAt: new Date().toISOString(),
          endedAt: null,
        });
        openRun(runId); // show the run in place, in the global dock
        toast.success(`${name}: started`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function onRunClick() {
    // Always open the dialog (even with no declared inputs) so overrides and the
    // dry-run preview are reachable.
    setValues(Object.fromEntries(inputs.map((k) => [k, ""])));
    setOverrides(EMPTY_OVERRIDES);
    setPreview(null);
    setOpen(true);
  }

  return (
    <div className="flex items-center gap-1.5">
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1.5 px-2 text-xs"
        disabled={isPending}
        onClick={onRunClick}
      >
        <Play className="size-3" />
        {isPending ? "…" : "Run"}
      </Button>

      {mine.length > 0 && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
          onClick={() => latest && openRun(latest.runId)}
          title={
            activeCount > 0
              ? `${activeCount} running — open latest`
              : "Open latest run"
          }
        >
          {activeCount > 0 ? (
            <StatusDot color="bg-emerald-500" pulse />
          ) : (
            <SquareTerminal className="size-3" />
          )}
          {activeCount > 0 ? `${activeCount} running` : "Console"}
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-mono">{name}</DialogTitle>
            <DialogDescription>
              Provide the {kind}&rsquo;s inputs, then run it. Progress and output
              stream into the run window.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              start(values);
            }}
            className="max-h-[70vh] space-y-3 overflow-y-auto"
          >
            {inputs.length === 0 && (
              <p className="text-xs text-muted-foreground">
                This {kind} declares no inputs.
              </p>
            )}
            {inputs.map((key) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={`in-${slug}-${key}`} className="font-mono text-xs">
                  {key}
                </Label>
                <Textarea
                  id={`in-${slug}-${key}`}
                  value={values[key] ?? ""}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [key]: e.target.value }))
                  }
                  rows={key === "topic" ? 1 : 3}
                  className="text-sm"
                  autoFocus={key === inputs[0]}
                />
              </div>
            ))}

            <details className="rounded-md border">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">
                Overrides (optional)
              </summary>
              <div className="space-y-3 border-t p-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">max turns</Label>
                    <Input
                      type="number"
                      min={1}
                      value={overrides.maxTurns}
                      onChange={(e) =>
                        setOverrides((o) => ({ ...o, maxTurns: e.target.value }))
                      }
                      placeholder="agent default"
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">timeout (s)</Label>
                    <Input
                      type="number"
                      min={1}
                      value={overrides.timeoutSec}
                      onChange={(e) =>
                        setOverrides((o) => ({ ...o, timeoutSec: e.target.value }))
                      }
                      placeholder="default 1800"
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">permission mode</Label>
                  <select
                    value={overrides.permissionMode}
                    onChange={(e) =>
                      setOverrides((o) => ({ ...o, permissionMode: e.target.value }))
                    }
                    className={`${SELECT_CLS} w-full`}
                  >
                    <option value="">agent default</option>
                    {PERMISSION_MODE_OPTS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </details>

            {preview && (
              <div className="space-y-2 rounded-md border bg-muted/30 p-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Prompt preview ({preview.length}{" "}
                  {preview.length === 1 ? "step" : "steps"}) — no tokens spent
                </p>
                {preview.map((s, i) => (
                  <div key={i} className="space-y-1">
                    <span className="font-mono text-xs text-muted-foreground">
                      {i + 1}. {s.label}
                    </span>
                    <pre className="max-h-40 overflow-auto rounded bg-background p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                      {s.prompt}
                    </pre>
                  </div>
                ))}
              </div>
            )}

            <DialogFooter showCloseButton>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={previewing}
                onClick={() => doPreview(values)}
              >
                <Eye className="size-3.5" />
                {previewing ? "…" : "Preview"}
              </Button>
              <Button type="submit" size="sm" disabled={isPending}>
                {isPending ? "Starting…" : "Run"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
