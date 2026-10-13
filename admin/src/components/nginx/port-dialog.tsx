"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangle, CircleAlert, Loader2 } from "lucide-react";

import { previewAppPortAction, setAppPortAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { PortChangePreview } from "@/lib/nginx";
import type { AppRow, DiffLine } from "@/lib/nginx-routes";

/** The changed lines with two of context round each change, the rest folded. */
function hunks(diff: DiffLine[], ctx = 2): (DiffLine | null)[] {
  const keep = diff.map((d, i) => d.op !== " " || diff.slice(Math.max(0, i - ctx), i + ctx + 1).some((x) => x.op !== " "));
  const out: (DiffLine | null)[] = [];
  diff.forEach((d, i) => {
    if (keep[i]) out.push(d);
    else if (out[out.length - 1] !== null) out.push(null);
  });
  return out;
}

/**
 * Change an app's port (T242): type it, preview (the conflict checks and the
 * generated include's diff), then apply: apps.port, the include rewritten,
 * `nginx -t` and reload by the root helper, the previous include back if the
 * test fails. A blocking conflict (another app's port, a live process's, out of
 * range) keeps Apply off.
 */
export function PortDialog({ app, onClose, onApplied }: { app: AppRow; onClose: () => void; onApplied: () => void }) {
  const [value, setValue] = useState(app.port === null ? "" : String(app.port));
  const [preview, setPreview] = useState<{ port: number | null; result: PortChangePreview } | null>(null);
  const [pending, start] = useTransition();
  const label = `${app.project}${app.app ? `/${app.app}` : ""}`;

  const parsed = (): number | null | undefined => {
    const v = value.trim();
    if (v === "") return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
  };

  const runPreview = () => {
    const port = parsed();
    if (port === undefined) return toast.error("A port is a whole number from 1 to 65535 (or empty, for no route).");
    start(async () => {
      try {
        setPreview({ port, result: await previewAppPortAction(app.project, app.appId, port) });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });
  };

  const apply = () => {
    if (!preview) return;
    start(async () => {
      try {
        const res = await setAppPortAction(app.project, app.appId, preview.port);
        if (res.ok) {
          toast.success(`${label}: ${preview.port === null ? "no longer routed" : `now on :${preview.port}`}. ${res.message}`);
          onApplied();
        } else {
          toast.error(res.message);
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });
  };

  const blocked = preview?.result.conflicts.some((c) => c.level === "block") ?? true;
  const stale = preview !== null && preview.port !== parsed();

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Port of {label}</DialogTitle>
          <DialogDescription>
            Routed at <code className="font-mono text-xs">{app.mount}</code>, now {app.port === null ? "not routed" : <code className="font-mono text-xs">:{app.port}</code>}.
            Applying rewrites the generated <code className="font-mono text-xs">projects.conf</code>, runs <code className="font-mono text-xs">nginx -t</code> and reloads; if the test fails, the previous file is put back.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => { e.preventDefault(); runPreview(); }} className="flex items-end gap-2">
          <label className="flex flex-col gap-1 text-sm">
            New port
            <Input value={value} onChange={(e) => setValue(e.target.value)} inputMode="numeric" placeholder="e.g. 4006 (empty: no route)" className="w-56 font-mono" autoFocus />
          </label>
          <Button type="submit" variant="outline" disabled={pending}>{pending && !preview ? <Loader2 className="size-4 animate-spin" /> : null} Preview</Button>
        </form>

        {preview && (
          <div className={cn("flex flex-col gap-3", stale && "opacity-50")}>
            {preview.result.conflicts.length > 0 ? (
              <ul className="space-y-1 text-sm">
                {preview.result.conflicts.map((c, i) => (
                  <li key={i} className={cn("flex items-start gap-1.5", c.level === "block" ? "text-red-600 dark:text-red-400" : "text-amber-700 dark:text-amber-400")}>
                    {c.level === "block" ? <CircleAlert className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
                    {c.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-emerald-700 dark:text-emerald-400">No conflict: the port is free and in range.</p>
            )}
            <div>
              <p className="mb-1 text-xs text-muted-foreground">projects.conf, before → after</p>
              {preview.result.changed ? (
                <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs leading-5">
                  {hunks(preview.result.diff).map((d, i) =>
                    d === null ? <div key={i} className="text-muted-foreground">⋯</div> : (
                      <div key={i} className={cn(d.op === "+" && "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300", d.op === "-" && "bg-red-500/15 text-red-800 dark:text-red-300")}>
                        {d.op} {d.text}
                      </div>
                    ),
                  )}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">No change to the generated file.</p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={apply} disabled={pending || !preview || stale || blocked || !preview.result.changed}>
            {pending && preview ? <Loader2 className="size-4 animate-spin" /> : null} Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
