"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { RefreshCw, Skull, Trash2, X } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BASE_PATH } from "@/lib/config";

const POLL_MS = 5000;

type ChromeInstance = {
  userDataDir: string;
  label: string;
  agentBrowser: boolean;
  rootPid: number;
  pids: number[];
  procCount: number;
  memMB: number;
  ageSeconds: number;
};

type ListResponse = {
  instances: ChromeInstance[];
  totalMemMB: number;
  ts: number;
};

type KillSignal = "SIGTERM" | "SIGKILL";

type KillResponse = {
  killed: number;
  failed: { pid: number; error: string }[];
};

export function ChromeInstances() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // userDataDir | "__all__"

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_PATH}/api/chrome`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const tick = () => {
      if (active) void load();
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [load]);

  const post = useCallback(
    async (body: Record<string, unknown>, busyKey: string, label: string) => {
      setBusy(busyKey);
      try {
        const res = await fetch(`${BASE_PATH}/api/chrome/kill`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json: KillResponse = await res
          .json()
          .catch(() => ({ killed: 0, failed: [] }));
        if (res.ok && json.failed.length === 0) {
          toast.success(`Killed ${label} — ${json.killed} processes`);
        } else if (json.killed > 0) {
          toast.warning(
            `${label}: killed ${json.killed}, ${json.failed.length} failed — ${json.failed[0]?.error ?? ""}`,
          );
        } else {
          toast.error(
            `Could not kill ${label}: ${json.failed[0]?.error ?? `HTTP ${res.status}`}`,
          );
        }
      } catch (e) {
        toast.error(`Kill failed: ${(e as Error).message}`);
      } finally {
        setBusy(null);
        // Reflect the change fast rather than waiting for the next poll.
        setTimeout(() => void load(), 400);
      }
    },
    [load],
  );

  const killOne = useCallback(
    (inst: ChromeInstance, signal: KillSignal) =>
      post(
        { userDataDir: inst.userDataDir, signal },
        inst.userDataDir,
        `${inst.label} (pid ${inst.rootPid})`,
      ),
    [post],
  );

  const killAll = useCallback(
    (signal: KillSignal) =>
      post({ all: true, signal }, "__all__", "all Chrome instances"),
    [post],
  );

  const instances = data?.instances ?? [];
  const totalMem = useMemo(
    () => instances.reduce((s, i) => s + i.memMB, 0),
    [instances],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void load()}>
          <RefreshCw /> Refresh
        </Button>

        <AlertDialog>
          <AlertDialogTrigger
            render={
              <Button
                size="sm"
                variant="destructive"
                disabled={busy !== null || instances.length === 0}
              />
            }
          >
            <Trash2 /> Kill all ({instances.length})
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Kill all Chrome instances?</AlertDialogTitle>
              <AlertDialogDescription>
                This sends SIGKILL to every one of the {instances.length} running
                Chrome instances ({fmtMem(totalMem)} total) and all their child
                processes. agent-browser will spawn a fresh instance the next
                time a session is used.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => void killAll("SIGKILL")}
              >
                Kill all
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <span className="ml-auto text-sm text-muted-foreground">
          {error
            ? "unavailable"
            : data
              ? `${instances.length} instances · ${fmtMem(totalMem)} · updated ${new Date(
                  data.ts,
                ).toLocaleTimeString()}`
              : "loading…"}
        </span>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Instance</TableHead>
              <TableHead>Root PID</TableHead>
              <TableHead className="text-right">Procs</TableHead>
              <TableHead className="text-right">Memory</TableHead>
              <TableHead className="text-right">Age</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {instances.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground"
                >
                  {data
                    ? "No Chrome instances running. 🎉"
                    : error
                      ? "Could not read process list."
                      : "…"}
                </TableCell>
              </TableRow>
            ) : (
              instances.map((inst) => {
                const rowBusy = busy === inst.userDataDir || busy === "__all__";
                return (
                  <TableRow key={inst.userDataDir}>
                    <TableCell className="max-w-[22rem]">
                      <div className="flex items-center gap-2">
                        <span
                          className="truncate font-mono text-xs"
                          title={inst.userDataDir}
                        >
                          {inst.label}
                        </span>
                        {inst.agentBrowser && (
                          <Badge variant="secondary" className="shrink-0">
                            agent-browser
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {inst.rootPid}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {inst.procCount}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtMem(inst.memMB)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {fmtAge(inst.ageSeconds)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={rowBusy}
                          onClick={() => void killOne(inst, "SIGTERM")}
                          title="Graceful kill (SIGTERM)"
                        >
                          <X /> Kill
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={rowBusy}
                          onClick={() => void killOne(inst, "SIGKILL")}
                          title="Force kill (SIGKILL)"
                        >
                          <Skull />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        Each instance is one headless Chrome (a browser process plus renderer/gpu
        children) under its own <code>--user-data-dir</code>. Killing an instance
        signals the whole group. The admin server and system processes are
        protected from being killed.
      </p>
    </div>
  );
}

function fmtMem(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function fmtAge(seconds: number): string {
  if (seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
