"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Boxes,
  FileText,
  Play,
  RotateCw,
  Square,
  Trash2,
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
  ContainerAction,
  DockerContainer,
  DockerImage,
  DockerSnapshot,
} from "@/lib/docker";

const POLL_MS = 5000;

type LogsState = {
  open: boolean;
  title: string;
  text: string;
  loading: boolean;
};

export function DockerManager() {
  const [data, setData] = useState<DockerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogsState>({
    open: false,
    title: "",
    text: "",
    loading: false,
  });

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_PATH}/api/docker`, { cache: "no-store" });
      const json: DockerSnapshot = await res.json();
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
    async (
      type: "container" | "image",
      id: string,
      action: ContainerAction | "remove",
      label: string,
    ) => {
      setBusy(id);
      try {
        const res = await fetch(`${BASE_PATH}/api/docker/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, id, action }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.ok) {
          toast.success(`${action} → ${label}`);
        } else {
          toast.error(
            `${action} failed: ${body.error ?? `HTTP ${res.status}`}`,
          );
        }
      } catch (e) {
        toast.error(`${action} failed: ${(e as Error).message}`);
      } finally {
        setBusy(null);
        setTimeout(() => void load(), 400);
      }
    },
    [load],
  );

  const openLogs = useCallback(async (c: DockerContainer) => {
    setLogs({ open: true, title: c.name || c.id.slice(0, 12), text: "", loading: true });
    try {
      const res = await fetch(
        `${BASE_PATH}/api/docker/logs?id=${encodeURIComponent(c.id)}&tail=500`,
        { cache: "no-store" },
      );
      const body = await res.json().catch(() => ({}));
      setLogs((s) => ({
        ...s,
        loading: false,
        text: body.ok ? body.logs || "(no output)" : `Error: ${body.error ?? res.status}`,
      }));
    } catch (e) {
      setLogs((s) => ({ ...s, loading: false, text: `Error: ${(e as Error).message}` }));
    }
  }, []);

  const containers = useMemo(() => {
    const list = data?.containers ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.image.toLowerCase().includes(q) ||
        c.state.includes(q),
    );
  }, [data, query]);

  const images = useMemo(() => {
    const list = data?.images ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (i) =>
        i.repository.toLowerCase().includes(q) ||
        i.tag.toLowerCase().includes(q) ||
        i.id.includes(q),
    );
  }, [data, query]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter containers & images…"
          className="max-w-xs"
        />
        <span className="ml-auto text-sm text-muted-foreground">
          {error
            ? `docker unavailable — ${error}`
            : data
              ? `${data.containers.length} containers · ${data.images.length} images · updated ${new Date(
                  data.ts,
                ).toLocaleTimeString()}`
              : "loading…"}
        </span>
      </div>

      {/* Containers */}
      <section className="space-y-2">
        <h2 className="flex items-center gap-2 text-lg font-medium">
          <Boxes className="size-4 text-muted-foreground" />
          Containers
          {data && <Badge variant="secondary">{containers.length}</Badge>}
        </h2>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-40">Name</TableHead>
                <TableHead className="hidden md:table-cell">Image</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden lg:table-cell">Ports</TableHead>
                <TableHead className="w-px text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {containers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    {data ? "No containers." : "…"}
                  </TableCell>
                </TableRow>
              ) : (
                containers.map((c) => {
                  const running = c.state === "running";
                  const disabled = busy === c.id;
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="max-w-40 truncate font-medium">
                        <span className="flex items-center gap-2">
                          <StateDot state={c.state} />
                          <span className="truncate" title={c.name}>
                            {c.name}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="hidden max-w-[16rem] truncate font-mono text-xs text-muted-foreground md:table-cell" title={c.image}>
                        {c.image}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {c.status}
                      </TableCell>
                      <TableCell className="hidden max-w-[14rem] truncate text-xs text-muted-foreground lg:table-cell" title={c.ports}>
                        {c.ports || "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {running ? (
                            <IconBtn
                              title="Stop"
                              disabled={disabled}
                              onClick={() => act("container", c.id, "stop", c.name)}
                            >
                              <Square className="size-3.5" />
                            </IconBtn>
                          ) : (
                            <IconBtn
                              title="Start"
                              disabled={disabled}
                              onClick={() => act("container", c.id, "start", c.name)}
                            >
                              <Play className="size-3.5" />
                            </IconBtn>
                          )}
                          <IconBtn
                            title="Restart"
                            disabled={disabled || !running}
                            onClick={() => act("container", c.id, "restart", c.name)}
                          >
                            <RotateCw className="size-3.5" />
                          </IconBtn>
                          <IconBtn title="Logs" onClick={() => openLogs(c)}>
                            <FileText className="size-3.5" />
                          </IconBtn>
                          <IconBtn
                            title="Remove"
                            destructive
                            disabled={disabled}
                            onClick={() => {
                              if (
                                confirm(
                                  `Remove container "${c.name}"?${running ? " It is running and will be force-removed." : ""}`,
                                )
                              )
                                act("container", c.id, "remove", c.name);
                            }}
                          >
                            <Trash2 className="size-3.5" />
                          </IconBtn>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      {/* Images */}
      <section className="space-y-2">
        <h2 className="flex items-center gap-2 text-lg font-medium">
          <Boxes className="size-4 text-muted-foreground" />
          Images
          {data && <Badge variant="secondary">{images.length}</Badge>}
        </h2>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Repository</TableHead>
                <TableHead className="hidden w-32 sm:table-cell">Tag</TableHead>
                <TableHead className="hidden w-28 md:table-cell">ID</TableHead>
                <TableHead className="hidden w-24 text-right sm:table-cell">Size</TableHead>
                <TableHead className="w-px text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {images.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    {data ? "No images." : "…"}
                  </TableCell>
                </TableRow>
              ) : (
                images.map((img: DockerImage) => (
                  <TableRow key={img.id + img.repository + img.tag}>
                    <TableCell className="max-w-[18rem] truncate font-medium" title={img.repository}>
                      {img.repository}
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                      {img.tag}
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
                      {img.id.replace(/^sha256:/, "").slice(0, 12)}
                    </TableCell>
                    <TableCell className="hidden text-right text-xs tabular-nums text-muted-foreground sm:table-cell">
                      {img.size}
                    </TableCell>
                    <TableCell className="text-right">
                      <IconBtn
                        title="Remove image"
                        destructive
                        disabled={busy === img.id}
                        onClick={() => {
                          const label = `${img.repository}:${img.tag}`;
                          if (confirm(`Remove image "${label}"?`))
                            act("image", img.id, "remove", label);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </IconBtn>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <Sheet open={logs.open} onOpenChange={(o) => setLogs((s) => ({ ...s, open: o }))}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle className="font-mono">{logs.title}</SheetTitle>
            <SheetDescription>Last 500 log lines (newest at bottom).</SheetDescription>
          </SheetHeader>
          <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words border-t p-4 font-mono text-xs">
            {logs.loading ? "loading…" : logs.text}
          </pre>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  disabled,
  destructive,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className={`size-7 ${destructive ? "text-muted-foreground hover:text-red-600" : "text-muted-foreground hover:text-foreground"}`}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

const STATE_COLOR: Record<string, string> = {
  running: "bg-emerald-500",
  restarting: "bg-amber-500",
  paused: "bg-amber-500",
  created: "bg-sky-500",
  exited: "bg-muted-foreground/40",
  dead: "bg-red-500",
};

function StateDot({ state }: { state: string }) {
  const color = STATE_COLOR[state] ?? "bg-muted-foreground/40";
  return (
    <span
      className={`inline-flex size-2 shrink-0 rounded-full ${color}`}
      title={state}
    />
  );
}
