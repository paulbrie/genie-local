"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  FileText,
  Play,
  Power,
  PowerOff,
  RotateCw,
  Square,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BASE_PATH } from "@/lib/config";
import type {
  ServiceAction,
  ServiceUnit,
  ServicesSnapshot,
} from "@/lib/services";

const POLL_MS = 6000;

type LogsState = { open: boolean; title: string; text: string; loading: boolean };

export function ServicesManager() {
  const [data, setData] = useState<ServicesSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogsState>({
    open: false,
    title: "",
    text: "",
    loading: false,
  });

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_PATH}/api/services`, { cache: "no-store" });
      const json: ServicesSnapshot = await res.json();
      setData(json);
      setError(res.ok ? null : (json.error ?? `HTTP ${res.status}`));
    } catch (e) {
      setError((e as Error).message);
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

  const act = useCallback(
    async (unit: string, action: ServiceAction) => {
      setBusy(unit);
      try {
        const res = await fetch(`${BASE_PATH}/api/services/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ unit, action }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.ok) {
          toast.success(`${action} → ${unit}`);
        } else {
          toast.error(`${action} ${unit} failed: ${body.error ?? `HTTP ${res.status}`}`);
        }
      } catch (e) {
        toast.error(`${action} ${unit} failed: ${(e as Error).message}`);
      } finally {
        setBusy(null);
        // systemd state settles a beat after the call returns.
        setTimeout(() => void load(), 600);
      }
    },
    [load],
  );

  const openLogs = useCallback(async (unit: string) => {
    setLogs({ open: true, title: unit, text: "", loading: true });
    try {
      const res = await fetch(
        `${BASE_PATH}/api/services/logs?unit=${encodeURIComponent(unit)}&lines=500`,
        { cache: "no-store" },
      );
      const body = await res.json().catch(() => ({}));
      setLogs((s) => ({
        ...s,
        loading: false,
        text: body.ok ? body.logs || "(no journal output)" : `Error: ${body.error ?? res.status}`,
      }));
    } catch (e) {
      setLogs((s) => ({ ...s, loading: false, text: `Error: ${(e as Error).message}` }));
    }
  }, []);

  const rows = useMemo(() => {
    let list = data?.services ?? [];
    if (!showAll) list = list.filter((s) => s.curated);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (s) =>
          s.unit.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      );
    }
    return list;
  }, [data, query, showAll]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by unit or description…"
          className="max-w-xs"
        />
        <Button
          size="sm"
          variant={showAll ? "default" : "outline"}
          onClick={() => setShowAll((v) => !v)}
          title="Toggle between the curated set and all service units"
        >
          {showAll ? "All units" : "Curated"}
        </Button>
        <span className="ml-auto text-sm text-muted-foreground">
          {error
            ? `services unavailable — ${error}`
            : data
              ? `${rows.length} shown · updated ${new Date(data.ts).toLocaleTimeString()}`
              : "loading…"}
        </span>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-56">Unit</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="w-24">State</TableHead>
              <TableHead className="w-24">Startup</TableHead>
              <TableHead className="w-px text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  {data ? "No matching services." : "…"}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((s) => (
                <ServiceRow
                  key={s.unit}
                  s={s}
                  busy={busy === s.unit}
                  onAct={act}
                  onLogs={openLogs}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Sheet open={logs.open} onOpenChange={(o) => setLogs((st) => ({ ...st, open: o }))}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle className="font-mono">{logs.title}</SheetTitle>
            <SheetDescription>Last 500 journal lines (newest at bottom).</SheetDescription>
          </SheetHeader>
          <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words border-t p-4 font-mono text-xs">
            {logs.loading ? "loading…" : logs.text}
          </pre>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ServiceRow({
  s,
  busy,
  onAct,
  onLogs,
}: {
  s: ServiceUnit;
  busy: boolean;
  onAct: (unit: string, action: ServiceAction) => void;
  onLogs: (unit: string) => void;
}) {
  const running = s.active === "active" || s.sub === "running";
  const enabled = s.enabled === "enabled";

  return (
    <TableRow>
      <TableCell className="max-w-56 truncate font-medium">
        <span className="flex items-center gap-2">
          <ActiveDot active={s.active} />
          <span className="truncate font-mono text-sm" title={s.unit}>
            {s.unit.replace(/\.service$/, "")}
          </span>
          {s.protected && (
            <Badge variant="outline" className="shrink-0 text-[10px]" title="stop/disable are blocked to avoid cutting the session">
              protected
            </Badge>
          )}
        </span>
      </TableCell>
      <TableCell className="max-w-[24rem] truncate text-xs text-muted-foreground" title={s.description}>
        {s.description || "—"}
      </TableCell>
      <TableCell>
        <Badge variant={running ? "default" : "secondary"} className="font-normal">
          {s.active}
          {s.sub && s.sub !== s.active ? ` (${s.sub})` : ""}
        </Badge>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {s.enabled || "—"}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          {running ? (
            <IconBtn
              title="Stop"
              disabled={busy || s.protected}
              onClick={() => onAct(s.unit, "stop")}
            >
              <Square className="size-3.5" />
            </IconBtn>
          ) : (
            <IconBtn title="Start" disabled={busy} onClick={() => onAct(s.unit, "start")}>
              <Play className="size-3.5" />
            </IconBtn>
          )}
          <IconBtn
            title="Restart"
            disabled={busy}
            onClick={() => {
              if (
                !s.protected ||
                confirm(`Restart protected unit ${s.unit}? This may briefly interrupt the dashboard/session.`)
              )
                onAct(s.unit, "restart");
            }}
          >
            <RotateCw className="size-3.5" />
          </IconBtn>
          {enabled ? (
            <IconBtn
              title="Disable at boot"
              disabled={busy || s.protected}
              onClick={() => onAct(s.unit, "disable")}
            >
              <PowerOff className="size-3.5" />
            </IconBtn>
          ) : (
            <IconBtn
              title="Enable at boot"
              disabled={busy}
              onClick={() => onAct(s.unit, "enable")}
            >
              <Power className="size-3.5" />
            </IconBtn>
          )}
          <IconBtn title="Journal logs" onClick={() => onLogs(s.unit)}>
            <FileText className="size-3.5" />
          </IconBtn>
        </div>
      </TableCell>
    </TableRow>
  );
}

function IconBtn({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className="size-7 text-muted-foreground hover:text-foreground"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

const ACTIVE_COLOR: Record<string, string> = {
  active: "bg-emerald-500",
  activating: "bg-amber-500",
  deactivating: "bg-amber-500",
  reloading: "bg-amber-500",
  failed: "bg-red-500",
  inactive: "bg-muted-foreground/40",
};

function ActiveDot({ active }: { active: string }) {
  const color = ACTIVE_COLOR[active] ?? "bg-muted-foreground/40";
  return (
    <span className={`inline-flex size-2 shrink-0 rounded-full ${color}`} title={active} />
  );
}
