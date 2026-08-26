"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Maximize2, Plus, TerminalSquare, Trash2 } from "lucide-react";
import { useSubject } from "subjecto/react";

import {
  killSession,
  statusLabel,
  TermStatusDot,
} from "@/components/terminal-dock";
import { TerminalVoiceControls } from "@/components/terminal-voice-controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BASE_PATH } from "@/lib/config";
import { dock, openTerminal } from "@/store/terminals";

const API = `${BASE_PATH}/api/terminals`;

type Terminal = {
  name: string;
  target: string;
  createdAt: number;
  attached: boolean;
  size: string;
  command: string;
  busy: boolean;
  status: import("@/store/terminals").TermStatus;
  cwd: string;
};

/**
 * Management list for tmux-backed terminals: create, open, and kill. Opening a
 * terminal pushes it into the global dock (`@/store/terminals`), which is
 * rendered by `<TerminalDock>` in the root layout — so the floating windows
 * live on across navigation, independent of this page.
 */
export function TerminalsPanel() {
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [{ open, minimized }] = useSubject(dock);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const refreshList = useCallback(async () => {
    try {
      const res = await fetch(API, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "failed to list");
      setTerminals(json.terminals ?? []);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const tick = () => {
      if (active) void refreshList();
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [refreshList]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "failed to create");
      toast.success(`Created terminal "${name}"`);
      setNewName("");
      await refreshList();
      openTerminal(name);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function kill(name: string) {
    if (!confirm(`Kill terminal "${name}"? Running processes will be stopped.`))
      return;
    if (await killSession(name)) await refreshList();
  }

  return (
    <div className="max-w-md space-y-3">
      <form onSubmit={create} className="flex gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="new terminal name"
          aria-label="New terminal name"
        />
        <Button type="submit" size="sm" disabled={creating || !newName.trim()}>
          <Plus /> New
        </Button>
      </form>

      <TerminalVoiceControls />

      <div className="space-y-1">
        {terminals.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            No terminals yet. Create one — it runs detached in tmux and survives
            page reloads and disconnects.
          </p>
        ) : (
          terminals.map((t) => (
            <div
              key={t.name}
              className="flex items-center gap-2 rounded-md border px-2.5 py-2 text-sm"
            >
              <TerminalSquare className="size-4 shrink-0 text-muted-foreground" />
              <TermStatusDot status={t.status} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{t.name}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {statusLabel(t.status)} · {t.size}
                </span>
              </span>
              {open.includes(t.name) && (
                <Badge variant="secondary" className="shrink-0">
                  {minimized.includes(t.name) ? "minimized" : "open"}
                </Badge>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 px-2"
                onClick={() => openTerminal(t.name)}
              >
                <Maximize2 /> Open
              </Button>
              <button
                type="button"
                aria-label={`Kill ${t.name}`}
                onClick={() => void kill(t.name)}
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Terminals open as floating windows that stay put as you move between
        pages. Drag the title bar to move, drag the bottom-right corner to
        resize, and use the − button to collapse a window into the bottom bar.
      </p>
    </div>
  );
}
