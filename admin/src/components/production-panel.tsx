"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { checkProductionAction, clearProductionAction, saveProductionAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusDot } from "@/components/ui/status-dot";
import { Textarea } from "@/components/ui/textarea";

type Saved = { url: string; notes: string; updatedAt: string };
type Check = { status?: number; ok?: boolean; ms?: number; finalUrl?: string; error?: string };

/** A project's Production tab: its production URL (checked live) and notes. */
export function ProductionPanel({ slug, initial }: { slug: string; initial: Saved | null }) {
  const [saved, setSaved] = useState(initial);
  const [url, setUrl] = useState(initial?.url ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [editing, setEditing] = useState(!initial);
  const [check, setCheck] = useState<Check | null>(null);
  const [checking, setChecking] = useState(false);
  const [pending, start] = useTransition();

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      setCheck(await checkProductionAction(slug));
    } catch (e) {
      setCheck({ error: (e as Error).message });
    } finally {
      setChecking(false);
    }
  }, [slug]);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(runCheck, 0);
    return () => clearTimeout(t);
  }, [saved, runCheck]);

  const save = () =>
    start(async () => {
      const r = await saveProductionAction(slug, url, notes);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
      setSaved({ url: new URL(normalized).toString(), notes, updatedAt: new Date().toISOString() });
      setUrl(new URL(normalized).toString());
      setEditing(false);
      toast.success("Saved");
    });

  const remove = () =>
    start(async () => {
      if (!confirm("Remove this project's production details?")) return;
      await clearProductionAction(slug);
      setSaved(null);
      setUrl("");
      setNotes("");
      setCheck(null);
      setEditing(true);
    });

  if (editing || !saved) {
    return (
      <form
        className="max-w-2xl space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="prod-url">Production URL</Label>
          <Input id="prod-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" autoFocus required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="prod-notes">Notes</Label>
          <Textarea
            id="prod-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={6}
            placeholder="Where it's hosted, how it deploys, accounts, anything worth knowing about production"
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit" disabled={pending || !url.trim()}>
            {pending ? "Saving…" : "Save"}
          </Button>
          {saved && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setUrl(saved.url);
                setNotes(saved.notes);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      </form>
    );
  }

  const up = check?.ok;
  return (
    <div className="max-w-2xl space-y-4">
      <div className="rounded-lg border p-4">
        <div className="text-xs font-medium text-muted-foreground">Production URL</div>
        <a href={saved.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1.5 text-lg font-medium break-all hover:underline">
          {saved.url}
          <ExternalLink className="size-4 shrink-0" />
        </a>
        <div className="mt-2 flex items-center gap-2 text-sm">
          {checking && !check ? (
            <span className="text-muted-foreground">Checking…</span>
          ) : check ? (
            <>
              <StatusDot color={up ? "bg-emerald-500" : "bg-red-500"} pulse={!!up} label={up ? "up" : "down"} />
              <span className={up ? "" : "text-destructive"}>
                {check.error ? `Unreachable: ${check.error}` : `HTTP ${check.status}${up ? "" : " (not OK)"}`}
                {check.ms != null && <span className="text-muted-foreground"> · {check.ms} ms</span>}
                {check.finalUrl && check.finalUrl !== saved.url && <span className="text-muted-foreground"> · ended at {check.finalUrl}</span>}
              </span>
            </>
          ) : null}
          <Button size="sm" variant="ghost" className="h-7" onClick={runCheck} disabled={checking} title="Check it again">
            <RefreshCw className={`size-3.5 ${checking ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>
      {saved.notes.trim() && (
        <div className="rounded-lg border p-4">
          <div className="text-xs font-medium text-muted-foreground">Notes</div>
          <p className="mt-1 text-sm whitespace-pre-wrap">{saved.notes}</p>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button variant="ghost" onClick={remove} disabled={pending}>
          Remove
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">Updated {new Date(saved.updatedAt).toLocaleString()}</span>
      </div>
    </div>
  );
}
