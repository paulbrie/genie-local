"use client";

// The Firewall page (mirrors genie's vps-egress-firewall.tsx): the status, the
// allowlist with add / remove, and the last 24 h of blocks with a one-click
// Allow. Every change answers with a fresh status from the server, so what's
// shown is always the box's truth, never optimistic.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Power, PowerOff, RefreshCw, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { confirmDialog } from "@/lib/ask";
import { BASE_PATH } from "@/lib/config";
import {
  ENTRY_HELP, MIN_RANGE_PREFIX, NOT_INSTALLED, normalizeEntry, validEntry, type Block, type FirewallResult,
  type FirewallStatus,
} from "@/lib/firewall-core";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

const API = `${BASE_PATH}/api/firewall`;

async function send(path: string, method: string, body: unknown): Promise<FirewallResult> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return json && typeof json.ok === "boolean" ? json : { ok: false, error: `HTTP ${res.status}` };
}

/** What "Allow" on a block adds: its reverse-DNS name when that's a valid entry, else the address. */
const allowTarget = (b: Block) => (b.ptr && validEntry(normalizeEntry(b.ptr)) ? normalizeEntry(b.ptr) : b.ip);

export function FirewallManager() {
  const [status, setStatus] = useState<FirewallStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The entry being added / removed, or "toggle".
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(API, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const tick = () => {
      if (active) void load();
    };
    tick();
    return () => {
      active = false;
    };
  }, [load]);

  const apply = useCallback((res: FirewallResult, done: string) => {
    if (res.status) setStatus(res.status);
    if (!res.ok) toast.error(res.error);
    else if (res.warning) toast.warning(res.warning);
    else toast.success(done);
    return res.ok;
  }, []);

  const add = useCallback(
    async (entry: string) => {
      setBusy(entry);
      try {
        return apply(await send("/allowlist", "POST", { entry }), `Allowed ${entry}`);
      } catch (e) {
        toast.error((e as Error).message);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [apply],
  );

  const enforced = status?.enforced === true;
  const canChange = !!status && status.sudo && status.installed;
  const appliesNow = enforced
    ? "The firewall is re-applied straight away."
    : "The firewall is off, so this takes effect when it's turned on.";

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const entry = normalizeEntry(draft);
    if (!validEntry(entry)) return void toast.error(ENTRY_HELP);
    if (await add(entry)) setDraft("");
  };

  const onRemove = async (entry: string) => {
    const ok = await confirmDialog(
      `Claude sessions and dev servers on this server won't be able to reach ${entry} any more. ${appliesNow}`,
      { title: `Remove ${entry} from the allowlist?`, confirmLabel: "Remove", destructive: true },
    );
    if (!ok) return;
    setBusy(entry);
    try {
      apply(await send("/allowlist", "DELETE", { entry }), `Removed ${entry}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onAllowBlocked = async (b: Block) => {
    const entry = allowTarget(b);
    const why =
      entry === b.ip
        ? `${b.ip} has no usable reverse-DNS name, so the address itself is allowed.`
        : `${entry} is what ${b.ip} reverse-resolves to; the firewall allows whatever that name resolves to. If the name doesn't resolve back, allow ${b.ip} instead.`;
    const ok = await confirmDialog(`${why} ${appliesNow}`, { title: `Allow ${entry}?`, confirmLabel: "Allow" });
    if (ok) await add(entry);
  };

  const onToggle = async () => {
    if (!status) return;
    const on = !enforced;
    if (!on) {
      const ok = await confirmDialog(
        "Every Claude session and dev server on this box will be able to connect anywhere on the internet, including " +
          "hosts a prompt-injected session could send your code or secrets to. genie-firewall.timer is disabled too, so it " +
          "stays off until it's turned back on here or in genie.",
        { title: "Turn the egress firewall off?", confirmLabel: "Turn off", destructive: true },
      );
      if (!ok) return;
    }
    setBusy("toggle");
    try {
      apply(await send("/toggle", "POST", { enabled: on }), on ? "Egress firewall on" : "Egress firewall off");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const badge = !status
    ? { text: error ? "Unavailable" : "…", variant: "secondary" as const, dot: "bg-muted-foreground" }
    : !status.installed
      ? { text: "Not installed", variant: "secondary" as const, dot: "bg-muted-foreground" }
      : status.enforced === null
        ? { text: "Unknown", variant: "secondary" as const, dot: "bg-amber-500" }
        : status.enforced
          ? { text: `Enforced · ${status.allowedIps} allowed`, variant: "default" as const, dot: "bg-emerald-500" }
          : { text: "Off", variant: "destructive" as const, dot: "bg-red-500" };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <StatusDot color={badge.dot} pulse={enforced} label={badge.text} />
            Claude egress
            <Badge variant={badge.variant} className="font-normal">
              {badge.text}
            </Badge>
          </CardTitle>
          <CardDescription>
            {status?.stateLine ? <code className="font-mono text-xs">{status.stateLine}</code> : "genie-firewall status"}
          </CardDescription>
          <CardAction className="flex items-center gap-1">
            {status?.installed && (
              <Button
                size="sm"
                variant={enforced ? "destructive" : "default"}
                disabled={!canChange || busy !== null || status.enforced === null}
                onClick={onToggle}
                title={
                  enforced
                    ? "genie-firewall off, and disable genie-firewall.timer"
                    : "genie-firewall (apply), and enable genie-firewall.timer"
                }
              >
                {busy === "toggle" ? <Loader2 className="animate-spin" /> : enforced ? <PowerOff /> : <Power />}
                {enforced ? "Turn off" : "Turn on"}
              </Button>
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              title="Refresh"
              aria-label="Refresh"
              disabled={loading}
              onClick={() => {
                setLoading(true);
                void load();
              }}
            >
              <RefreshCw className={loading ? "animate-spin" : ""} />
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {error && !status && <p className="text-destructive">Couldn&apos;t load the firewall status: {error}</p>}
          {status && (
            <>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
                <span title={status.timer.lastTrigger ? formatDateTime(status.timer.lastTrigger) : undefined}>
                  Last applied:{" "}
                  <span className="text-foreground">
                    {status.timer.lastTrigger ? formatRelativeTime(status.timer.lastTrigger) : "never"}
                  </span>
                  {status.timer.lastResult && status.timer.lastResult !== "success" && (
                    <span className="text-destructive"> ({status.timer.lastResult})</span>
                  )}
                </span>
                <span>
                  <code className="font-mono text-xs">genie-firewall.timer</code>: {status.timer.active || "—"},{" "}
                  {status.timer.enabled || "—"} (re-resolves the allowlist every 10 min)
                </span>
              </div>
              {!status.sudo && (
                <p className="rounded-md border px-3 py-2 text-muted-foreground">
                  <code className="font-mono text-xs">sudo -n</code> was refused for the genie user, so this page is
                  read-only: the firewall&apos;s state can&apos;t be read and nothing can be changed from here.
                </p>
              )}
              {!status.installed && <p className="rounded-md border px-3 py-2 text-muted-foreground">{NOT_INSTALLED}</p>}
              {status.installed && !status.rangesSupported && (
                <p className="text-xs text-muted-foreground">
                  The installed <code className="font-mono">genie-firewall</code> predates IPv4 ranges: ranges in the
                  allowlist are skipped until genie updates it (turning the firewall on from genie rewrites it).
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Allowlist</CardTitle>
          <CardDescription>
            <code className="font-mono text-xs">/etc/genie/firewall-allow.txt</code>: domains, IPv4 addresses and
            ranges (no wider than /{MIN_RANGE_PREFIX}). api.anthropic.com and genie&apos;s auto-added manager address
            can&apos;t be removed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form className="flex items-center gap-2" onSubmit={onAdd}>
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="api.example.com"
              className="max-w-xs font-mono"
              disabled={!canChange}
              aria-label="Domain, address or range to allow"
            />
            <Button type="submit" size="sm" disabled={!canChange || !draft.trim() || busy !== null}>
              {busy !== null && busy === normalizeEntry(draft) ? <Loader2 className="animate-spin" /> : <Plus />}
              Allow
            </Button>
            {draft.trim() && !validEntry(normalizeEntry(draft)) && (
              <span className="text-xs text-muted-foreground">{ENTRY_HELP}</span>
            )}
          </form>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-72">Entry</TableHead>
                  <TableHead>Comment</TableHead>
                  <TableHead className="w-px" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {!status ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      {error ? "—" : "loading…"}
                    </TableCell>
                  </TableRow>
                ) : status.allowlist.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      {status.allowFile ? "The allowlist is empty." : "No allowlist on this server yet; genie's firewall setup creates it."}
                    </TableCell>
                  </TableRow>
                ) : (
                  status.allowlist.map((a) => (
                    <TableRow key={a.entry}>
                      <TableCell className="font-mono text-sm">
                        <span className="flex items-center gap-2">
                          {a.entry}
                          {a.protected && (
                            <Badge variant="outline" className="text-[10px]" title="Required; can't be removed">
                              protected
                            </Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-md truncate text-xs text-muted-foreground" title={a.comment}>
                        {a.comment ?? ""}
                      </TableCell>
                      <TableCell className="text-right">
                        {!a.protected && (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="size-7 text-muted-foreground hover:text-destructive"
                            title={`Remove ${a.entry}`}
                            aria-label={`Remove ${a.entry}`}
                            disabled={!canChange || busy !== null}
                            onClick={() => void onRemove(a.entry)}
                          >
                            {busy === a.entry ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Blocked in the last 24 h</CardTitle>
          <CardDescription>
            From the kernel log (<code className="font-mono text-xs">genie-egress-block:</code>, rate-limited to 6 a
            minute), by address and port, with reverse-DNS names where there are any.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Host</TableHead>
                  <TableHead className="w-28">Port</TableHead>
                  <TableHead className="w-20 text-right">Count</TableHead>
                  <TableHead className="w-36">Last seen</TableHead>
                  <TableHead className="w-px" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {!status || status.blocks.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      {!status ? (error ? "—" : "loading…") : "Nothing blocked in the last 24 hours."}
                    </TableCell>
                  </TableRow>
                ) : (
                  status.blocks.map((b) => {
                    const target = allowTarget(b);
                    return (
                      <TableRow key={`${b.ip}:${b.port ?? "-"}`}>
                        <TableCell className="font-mono text-sm">
                          <div className="truncate" title={b.ptr ?? b.ip}>
                            {b.ptr ?? b.ip}
                          </div>
                          {b.ptr && <div className="text-xs text-muted-foreground">{b.ip}</div>}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {b.proto?.toLowerCase()}
                          {b.port ? `:${b.port}` : ""}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{b.count}</TableCell>
                        <TableCell className="text-xs text-muted-foreground" title={b.lastSeen ? formatDateTime(b.lastSeen) : undefined}>
                          {formatRelativeTime(b.lastSeen)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={!canChange || busy !== null}
                            title={`Allow ${target}`}
                            onClick={() => void onAllowBlocked(b)}
                          >
                            {busy === target ? <Loader2 className="animate-spin" /> : <Plus />}
                            Allow
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
