"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Copy, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BASE_PATH } from "@/lib/config";
import type { BoardSummary } from "@/lib/boards/db";
import { confirmDialog, promptDialog } from "@/lib/ask";

import { identity, loadIdentity } from "./identity";

const STICKY_TINTS = ["#fde68a", "#93c5fd", "#86efac", "#f9a8d4"];

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE_PATH}/api/boards${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

function ago(d: Date | string) {
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(d).toLocaleDateString();
}

export function BoardsManager({ initial, initialArchived }: { initial: BoardSummary[]; initialArchived: BoardSummary[] }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<void>) =>
    start(async () => {
      try {
        await fn();
      } catch (e) {
        toast.error((e as Error).message);
      }
    });

  const create = () =>
    run(async () => {
      loadIdentity();
      const row = await api("", {
        method: "POST",
        body: JSON.stringify({ title: title.trim() || "Untitled board", createdBy: identity.getValue()?.name }),
      });
      router.push(`/boards/${row.id}`);
    });

  return (
    <div className="space-y-6">
      <form
        className="flex max-w-md gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New board name" data-testid="new-board-title" />
        <Button type="submit" disabled={pending} data-testid="new-board">
          <Plus /> New board
        </Button>
      </form>

      {initial.length === 0 ? (
        <p className="text-sm text-muted-foreground">No boards yet. Create one to get started.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {initial.map((b) => (
            <div key={b.id} className="group relative overflow-hidden rounded-xl border bg-card shadow-sm transition hover:shadow-md">
              <Link href={`/boards/${b.id}`} className="block" data-testid={`board-card-${b.id}`}>
                <div
                  className="relative h-32 overflow-hidden bg-zinc-50 dark:bg-zinc-900"
                  style={{ backgroundImage: "radial-gradient(circle, rgb(161 161 170 / 0.45) 1px, transparent 1px)", backgroundSize: "14px 14px" }}
                >
                  {b.preview.map((t, i) => (
                    <div
                      key={i}
                      className="absolute w-20 overflow-hidden p-1.5 text-[9px] leading-tight text-zinc-800 shadow"
                      style={{ background: STICKY_TINTS[i % 4], height: 60, left: 16 + i * 62, top: 18 + (i % 2) * 34, rotate: `${(i % 3) - 1}deg` }}
                    >
                      {t.slice(0, 60)}
                    </div>
                  ))}
                </div>
                <div className="p-3">
                  <div className="truncate font-medium">{b.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {b.items} item{b.items === 1 ? "" : "s"} · edited {ago(b.updatedAt)}
                    {b.createdBy ? ` · by ${b.createdBy}` : ""}
                  </div>
                </div>
              </Link>
              <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
                <Button
                  size="icon-xs"
                  variant="secondary"
                  title="Rename"
                  onClick={async () => {
                    const t = await promptDialog("Board name", b.title, { confirmLabel: "Rename" });
                    if (t?.trim())
                      run(async () => {
                        await api(`/${b.id}`, { method: "PATCH", body: JSON.stringify({ title: t.trim() }) });
                        router.refresh();
                      });
                  }}
                >
                  <Pencil />
                </Button>
                <Button
                  size="icon-xs"
                  variant="secondary"
                  title="Duplicate"
                  onClick={() =>
                    run(async () => {
                      const src = await api(`/${b.id}`);
                      await api("", { method: "POST", body: JSON.stringify({ title: `${b.title} (copy)`, createdBy: identity.getValue()?.name, doc: { ...src.doc, chat: [] } }) });
                      router.refresh();
                    })
                  }
                >
                  <Copy />
                </Button>
                <Button
                  size="icon-xs"
                  variant="secondary"
                  title="Archive"
                  onClick={() =>
                    run(async () => {
                      await api(`/${b.id}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
                      router.refresh();
                    })
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {initialArchived.length > 0 && (
        <section className="space-y-2">
          <button className="flex items-center gap-1 text-sm text-muted-foreground" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            Archived ({initialArchived.length})
          </button>
          {showArchived && (
            <ul className="divide-y rounded-lg border">
              {initialArchived.map((b) => (
                <li key={b.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="flex-1 truncate">{b.title}</span>
                  <span className="text-xs text-muted-foreground">{b.items} items</span>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      run(async () => {
                        await api(`/${b.id}`, { method: "PATCH", body: JSON.stringify({ archived: false }) });
                        router.refresh();
                      })
                    }
                  >
                    <RotateCcw /> Restore
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="text-destructive"
                    onClick={async () => {
                      if (await confirmDialog(`Delete "${b.title}" for good?`, { confirmLabel: "Delete", destructive: true }))
                        run(async () => {
                          await api(`/${b.id}`, { method: "DELETE" });
                          router.refresh();
                        });
                    }}
                  >
                    <Trash2 /> Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
