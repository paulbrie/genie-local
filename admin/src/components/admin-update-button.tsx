"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDownToLine, Loader2, Rocket } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { BASE_PATH } from "@/lib/config";
import { cn } from "@/lib/utils";

type Status = {
  branch: string;
  behind: number;
  ahead: number;
  incoming: string[];
  undeployed: number;
  undeployedLog: string[];
  dirty: number;
  blocked: string | null;
};

type Result = { ok: boolean; steps: string[]; error?: string; log: string };

/** How often to ask GitHub whether there's anything new. */
const POLL_MS = 3 * 60_000;

/**
 * Shows up in the toolbar only when GitHub is ahead of this checkout, and
 * updates the admin to match: pull, reinstall if the lockfile moved, then
 * build, migrate and restart. Or, when the commits are made here (so GitHub is
 * never ahead), when the running build is older than the checkout: then it only
 * deploys. The restart takes this page with it for a moment, which the
 * confirmation says plainly.
 */
export function AdminUpdateButton() {
  const [status, setStatus] = useState<Status | null>(null);
  const [running, setRunning] = useState(false);

  const check = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_PATH}/api/admin-update`, { cache: "no-store" });
      if (res.ok) setStatus(await res.json());
    } catch {
      /* the box is busy or the admin is restarting; the next poll will tell */
    }
  }, []);

  useEffect(() => {
    // Off the mount tick: the first look talks to GitHub and shouldn't hold up
    // the page the toolbar sits on.
    const first = setTimeout(check, 0);
    const t = setInterval(check, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [check]);

  if (!status || (status.behind < 1 && (status.undeployed ?? 0) < 1)) return null;

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
      !window.confirm(
        `${ask}\n\n${listed}${more}\n\nIt will build, migrate and restart, so this page will blink.`,
      )
    ) {
      return;
    }
    setRunning(true);
    const note = toast.loading(local ? "Deploying the admin…" : "Updating the admin…");
    try {
      const res = await fetch(`${BASE_PATH}/api/admin-update`, { method: "POST" });
      const body: Result = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? res.statusText);
      toast.success(body.steps.join(" "), { id: note, duration: 10_000 });
      // The restart lands within a few seconds; come back to a fresh build.
      setTimeout(() => window.location.reload(), 25_000);
    } catch (e) {
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
