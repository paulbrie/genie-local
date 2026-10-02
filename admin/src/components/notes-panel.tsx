"use client";

import { GripVertical, Pencil, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  addNoteAction,
  deleteNoteAction,
  reorderNotesAction,
  updateNoteAction,
} from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Note } from "@/db/schema";
import { formatRelativeTime } from "@/lib/format";

export function NotesPanel({ slug, notes }: { slug: string; notes: Note[] }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [isPending, startTransition] = useTransition();

  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [bodyOverrides, setBodyOverrides] = useState<Record<number, string>>({});

  // Deferred-delete timers so "Undo" can cancel before the server call fires.
  const deleteTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  useEffect(() => {
    const timers = deleteTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
    };
  }, []);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editBody, setEditBody] = useState("");

  const idsKey = notes.map((n) => n.id).join(",");
  const [order, setOrder] = useState<number[]>(() => notes.map((n) => n.id));
  useEffect(() => {
    setOrder(notes.map((n) => n.id));
  }, [idsKey]);

  const ordered = useMemo(() => {
    const byId = new Map(notes.map((n) => [n.id, n]));
    return order
      .map((id) => byId.get(id))
      .filter((n): n is Note => !!n && !removed.has(n.id))
      .map((n) => ({ ...n, body: bodyOverrides[n.id] ?? n.body }));
  }, [notes, order, removed, bodyOverrides]);

  const canDrag = editingId === null;
  const dragId = useRef<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  function onDragStart(e: React.DragEvent, id: number) {
    dragId.current = id;
    setDragging(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(id));
  }
  function onDragEnd() {
    dragId.current = null;
    setDragging(null);
  }
  function onDragOver(e: React.DragEvent, overId: number) {
    if (!canDrag || dragId.current == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const from = dragId.current;
    if (from === overId) return;
    setOrder((o) => {
      const a = [...o];
      const fi = a.indexOf(from);
      const ti = a.indexOf(overId);
      if (fi < 0 || ti < 0) return o;
      a.splice(fi, 1);
      a.splice(ti, 0, from);
      return a;
    });
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const moved = dragId.current;
    dragId.current = null;
    setDragging(null);
    if (moved == null) return;
    const finalOrder = order;
    startTransition(async () => {
      try {
        await reorderNotesAction(slug, finalOrder);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  }

  function onAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    if (!(formData.get("body") as string)?.trim()) return;
    startTransition(async () => {
      try {
        await addNoteAction(slug, formData);
        form.reset();
        toast.success("Note added");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  }

  function restore(id: number) {
    setRemoved((r) => {
      const next = new Set(r);
      next.delete(id);
      return next;
    });
  }

  function remove(note: Note) {
    setRemoved((r) => new Set(r).add(note.id));
    const timer = setTimeout(() => {
      deleteTimers.current.delete(note.id);
      startTransition(async () => {
        try {
          await deleteNoteAction(slug, note.id);
        } catch (err) {
          restore(note.id);
          toast.error(err instanceof Error ? err.message : String(err));
        }
      });
    }, 5000);
    deleteTimers.current.set(note.id, timer);
    toast("Note deleted", {
      duration: 5000,
      action: {
        label: "Undo",
        onClick: () => {
          const t = deleteTimers.current.get(note.id);
          if (t) clearTimeout(t);
          deleteTimers.current.delete(note.id);
          restore(note.id);
        },
      },
    });
  }

  function startEdit(note: { id: number; body: string }) {
    setEditingId(note.id);
    setEditBody(note.body);
  }

  function saveEdit(noteId: number) {
    const body = editBody.trim();
    if (!body) {
      toast.error("Note can't be empty");
      return;
    }
    setBodyOverrides((o) => ({ ...o, [noteId]: body }));
    setEditingId(null);
    startTransition(async () => {
      try {
        await updateNoteAction(slug, noteId, body);
        toast.success("Note updated");
      } catch (err) {
        setBodyOverrides((o) => {
          const next = { ...o };
          delete next[noteId];
          return next;
        });
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <div className="space-y-4">
      <form ref={formRef} onSubmit={onAdd} className="space-y-2">
        <Textarea
          name="body"
          placeholder="Add a note about this project…"
          rows={3}
          required
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={isPending}>
            {isPending ? "Saving…" : "Add note"}
          </Button>
        </div>
      </form>

      {ordered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notes yet.</p>
      ) : (
        <ul className="space-y-2">
          {ordered.map((n) =>
            editingId === n.id ? (
              <li key={n.id} className="rounded-md border p-3">
                <Textarea
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  rows={3}
                  autoFocus
                  className="text-sm"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setEditingId(null);
                  }}
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditingId(null)}
                  >
                    Cancel
                  </Button>
                  <Button type="button" size="sm" onClick={() => saveEdit(n.id)}>
                    Save
                  </Button>
                </div>
              </li>
            ) : (
              <li
                key={n.id}
                onDragOver={(e) => onDragOver(e, n.id)}
                onDrop={onDrop}
                className={`group flex items-start gap-2 rounded-md border p-3 text-sm transition-opacity ${
                  dragging === n.id ? "opacity-40" : ""
                }`}
              >
                {canDrag && (
                  <span
                    draggable
                    onDragStart={(e) => onDragStart(e, n.id)}
                    onDragEnd={onDragEnd}
                    aria-label="Drag to reorder"
                    className="mt-0.5 cursor-grab touch-none select-none text-muted-foreground/50 active:cursor-grabbing"
                  >
                    <GripVertical className="size-4" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap break-words">{n.body}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground/70">
                    {formatRelativeTime(n.createdAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => startEdit(n)}
                    disabled={isPending}
                    aria-label="Edit note"
                    className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(n)}
                    disabled={isPending}
                    aria-label="Delete note"
                    className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
