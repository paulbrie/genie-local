"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Loader2, Rocket } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { BASE_PATH } from "@/lib/config";
import { cn } from "@/lib/utils";
import { confirmDialog } from "@/lib/ask";

type Status = {
  branch: string;
  behind: number;
  ahead: number;
  incoming: string[];
  undeployed: number;
  undeployedLog: string[];
  dirty: number;
  blocked: string | null;
  /** the commit the running admin was built from (prod) */
  built: string | null;
  deploying: boolean;
  lastDeploy: "success" | "failed" | "none";
};

type Result = { ok: boolean; steps: string[]; error?: string; log: string };

/** How often to ask GitHub whether there's anything new. */
const POLL_MS = 3 * 60_000;
/** While a deploy builds: how often to look whether the new build is up. */
const DEPLOY_POLL_MS = 4000;
/** Past this, stop waiting and say so (the Logs page has the deploy's log). */
const DEPLOY_WAIT_MS = 10 * 60_000;

/**
 * Shows up in the toolbar only when GitHub is ahead of this checkout, and
 * updates the admin to match: pull, reinstall if the lockfile moved, then
 * build, migrate and restart. Or, when the commits are made here (so GitHub is
 * never ahead), when the running build is older than the checkout: then it only
 * deploys. The restart takes this page with it for a moment, which the
 * confirmation says plainly.
 *
 * A deploy builds for a minute or so before it restarts: meanwhile (from this
 * tab or another, before a reload or after) the button says "Deploying…" and
 * can't be pressed, and the page reloads once the new build answers (its
 * `built` commit changed), not on a timer that could land on the old one.
 */
export function AdminUpdateButton() {
  const [status, setStatus] = useState<Status | null>(null);
  const [running, setRunning] = useState(false);
  // While waiting for a deploy: the build that was serving when it began, whether it was seen running yet, since when.
  const wait = useRef<{ from: string | null; seen: boolean; at: number; toast: string | number } | null>(null);

  const check = useCallback(async () => {
    let next: Status;
    try {
      const res = await fetch(`${BASE_PATH}/api/admin-update`, { cache: "no-store" });
      if (!res.ok) return;
      next = await res.json();
    } catch {
      return; /* the box is busy or the admin is restarting; the next poll will tell */
    }
    setStatus(next);
    // a deploy found running (another tab's, or before a reload): wait for it like ours
    if (next.deploying && !wait.current) {
      wait.current = { from: next.built, seen: true, at: Date.now(), toast: toast.loading("Deploying the admin…") };
      setRunning(true);
    }
    const w = wait.current;
    if (!w) return;
    if (next.deploying) w.seen = true;
    const landed = next.built !== w.from || (w.seen && !next.deploying && next.lastDeploy === "success");
    if (landed) {
      wait.current = null;
      toast.success("Deployed: reloading on the new version", { id: w.toast, duration: 4000 });
      // (the dev instance isn't the one rebuilt: no new build of its own to load)
      if (next.built !== w.from) window.setTimeout(() => window.location.reload(), 600);
      else setRunning(false);
    } else if (w.seen && !next.deploying && next.lastDeploy === "failed") {
      wait.current = null;
      setRunning(false);
      toast.error("The deploy failed: the Logs page has admin-deploy.log", { id: w.toast, duration: 15_000 });
    } else if (Date.now() - w.at > DEPLOY_WAIT_MS) {
      wait.current = null;
      setRunning(false);
      toast.error("The deploy is taking very long: see admin-deploy.log on the Logs page", { id: w.toast, duration: 15_000 });
    }
  }, []);

  useEffect(() => {
    // Off the mount tick: the first look talks to GitHub and shouldn't hold up
    // the page the toolbar sits on.
    const first = setTimeout(check, 0);
    const t = setInterval(check, running ? DEPLOY_POLL_MS : POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [check, running]);

  if (!status) return null;
  if (running || status.deploying) {
    return (
      <Button size="sm" className="h-7 gap-1.5" disabled data-testid="admin-update" title="Building the new version; the admin restarts by itself and this page reloads on it">
        <Loader2 className="animate-spin" />
        Deploying…
      </Button>
    );
  }
  if (status.behind < 1 && (status.undeployed ?? 0) < 1) return null;

  // (nothing on GitHub to take: the commits are here, only not deployed)
  const local = status.behind < 1;
  const n = local ? status.undeployed : status.behind;
  const subjects = local ? status.undeployedLog : status.incoming;
  const what = local ? `Deploy ${n} commit${n === 1 ? "" : "s"}` : `${n} update${n === 1 ? "" : "s"}`;
  const listed = subjects.slice(0, 8).map((s) => `· ${s}`).join("\n");
  const more = subjects.length > 8 ? `\n…and ${subjects.length - 8} more` : "";
  const ask = local ? "Deploy the commits the running admin doesn't have yet?" : "Update the admin to the latest on GitHub?";

  const update = async () => {
    if (status.blocked) {
      toast.error(status.blocked);
      return;
    }
    if (
      !(await confirmDialog(`${listed}${more}\n\nIt will build, migrate and restart, so this page will blink.`, {
        title: ask,
        confirmLabel: local ? "Deploy" : "Update",
      }))
    ) {
      return;
    }
    const note = toast.loading(local ? "Deploying the admin…" : "Updating the admin…");
    // (set before asking, so a poll that sees the deploy running meanwhile waits on this one, not a second)
    wait.current = { from: status.built, seen: false, at: Date.now(), toast: note };
    setRunning(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/admin-update`, { method: "POST" });
      const body: Result = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? res.statusText);
      // (the build takes a minute or so: the polls tell when the new one is up, then reload)
      if (wait.current) toast.loading(`${body.steps.join(" ")} This page reloads on the new version.`, { id: note });
    } catch (e) {
      wait.current = null;
      toast.error((e as Error).message, { id: note, duration: 12_000 });
      setRunning(false);
      check();
    }
  };

  return (
    <Button
      size="sm"
      variant={status.blocked ? "outline" : "default"}
      className={cn("h-7 gap-1.5", status.blocked && "border-amber-500/60 text-amber-600")}
      disabled={running}
      onClick={update}
      title={
        status.blocked
          ? `${what} waiting, but: ${status.blocked}`
          : `${ask}\n${listed}${more}`
      }
      data-testid="admin-update"
    >
      {running ? <Loader2 className="animate-spin" /> : local ? <Rocket /> : <ArrowDownToLine />}
      {running ? (local ? "Deploying…" : "Updating…") : what}
    </Button>
  );
}
