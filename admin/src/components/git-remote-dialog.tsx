"use client";

import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BASE_PATH } from "@/lib/config";

type Saved = { remoteUrl: string; hasToken: boolean; tokenHint: string | null; updatedAt: string };
type Info = { app: string; origin: string | null; saved: Saved | null };

const API = `${BASE_PATH}/api/git/remote`;

/**
 * A repo's GitHub URL (made its origin) and personal access token, for the Git
 * tab's Push and Refresh. The token is stored encrypted and never shown again:
 * leave the field empty to keep it, or type a new one to replace it.
 */
export function GitRemoteDialog({ projectSlug, app, onClose, onSaved }: { projectSlug: string; app: string; onClose: () => void; onSaved: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`${API}?${new URLSearchParams({ project: projectSlug, app })}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        return j as Info;
      })
      .then((j) => {
        if (!live) return;
        setInfo(j);
        setUrl(j.saved?.remoteUrl ?? (j.origin && !j.origin.includes("***@") ? j.origin : ""));
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [projectSlug, app]);

  const save = async (opts: { clearToken?: boolean } = {}) => {
    setBusy(true);
    setCheck(null);
    try {
      const r = await fetch(API, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: projectSlug, app: info?.app ?? app, remoteUrl: url, ...(token.trim() ? { token } : {}), ...opts }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setInfo((i) => ({ app: i?.app ?? app, origin: j.origin, saved: j.saved }));
      setUrl(j.saved.remoteUrl);
      setToken("");
      setCheck(j.check);
      if (j.check.ok) toast.success(`Saved: ${j.check.message}`);
      else toast.warning("Saved, but the remote refused it (see the dialog)");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    setBusy(true);
    try {
      const r = await fetch(API, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: projectSlug, app: info?.app ?? app }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      setInfo((i) => (i ? { ...i, saved: null } : i));
      setCheck(null);
      toast.success("Forgot the saved URL and token (origin is unchanged)");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saved = info?.saved;
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4" />
            GitHub remote{info?.app ? ` · ${info.app}` : ""}
          </DialogTitle>
          <DialogDescription>
            The repo&apos;s origin, and the personal access token Push and Refresh use for it. The token is stored
            encrypted and only ever sent to that host.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="git-remote-url">GitHub URL</Label>
            <Input
              id="git-remote-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo (or owner/repo)"
              className="font-mono text-xs md:text-xs"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              origin now: <span className="font-mono">{info ? (info.origin ?? "none") : "…"}</span>
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="git-remote-token">Personal access token</Label>
            <Input
              id="git-remote-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={saved?.hasToken ? `saved (…${saved.tokenHint}): leave empty to keep it` : "ghp_… or github_pat_…"}
              autoComplete="off"
              className="font-mono text-xs md:text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Fine-grained: give it this repo with Contents read &amp; write. Classic: the <span className="font-mono">repo</span> scope.
            </p>
          </div>
          {check && (
            <p className={`text-xs ${check.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}`}>
              {check.ok ? "✓ " : "✗ "}
              {check.message}
            </p>
          )}

          <DialogFooter className="gap-2 sm:justify-between">
            <div className="flex gap-2">
              {saved?.hasToken && (
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void save({ clearToken: true })}>
                  Remove token
                </Button>
              )}
              {saved && (
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void forget()}>
                  Forget all
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
                Close
              </Button>
              <Button type="submit" disabled={busy || !url.trim()}>
                {busy ? "Saving & checking…" : "Save"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
