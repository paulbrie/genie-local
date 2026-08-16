"use client";

import { useState, useTransition } from "react";
import { Play, SquareTerminal } from "lucide-react";
import { toast } from "sonner";
import { useSubject } from "subjecto/react";

import { runAgentAction, runPipelineAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { activeRuns, openRun, upsertActiveRun } from "@/store/runs";

type Kind = "agent" | "pipeline";

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
  const [isPending, startTransition] = useTransition();

  const mine = runs.filter((r) => r.kind === kind && r.slug === slug);
  const activeCount = mine.filter(
    (r) => r.running || r.state === "running" || r.state === "starting",
  ).length;
  const latest = mine[0]; // activeRuns is newest-first

  function start(vals: Record<string, string>) {
    startTransition(async () => {
      try {
        const runId =
          kind === "agent"
            ? await runAgentAction(slug, vals)
            : await runPipelineAction(slug, vals);
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
    if (inputs.length === 0) start({});
    else {
      setValues(Object.fromEntries(inputs.map((k) => [k, ""])));
      setOpen(true);
    }
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
            <span className="relative flex size-2 items-center justify-center">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400/70" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
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
            className="space-y-3"
          >
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
            <DialogFooter showCloseButton>
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
