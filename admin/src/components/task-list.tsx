"use client";

import { GripVertical, Pencil, Trash2 } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";

import {
  addTaskAction,
  deleteTaskAction,
  reorderTasksAction,
  toggleTaskAction,
  updateTaskAction,
} from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Task } from "@/db/schema";
import { formatRelativeTime } from "@/lib/format";

type Filter = "all" | "open" | "done";

export function TaskList({ slug, tasks }: { slug: string; tasks: Task[] }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [isPending, startTransition] = useTransition();

  // Optimistic overrides so the UI reacts instantly before revalidation.
  const [doneOverrides, setDoneOverrides] = useState<Record<number, boolean>>(
    {},
  );
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [fieldOverrides, setFieldOverrides] = useState<
    Record<number, { title: string; description: string | null }>
  >({});

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

  const [filter, setFilter] = useState<Filter>("all");

  // Inline-edit state (one task at a time).
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");

  // Local (optimistic) drag order; resynced whenever the set of ids changes.
  const idsKey = tasks.map((t) => t.id).join(",");
  const [order, setOrder] = useState<number[]>(() => tasks.map((t) => t.id));
  useEffect(() => {
    setOrder(tasks.map((t) => t.id));
  }, [idsKey]);

  const ordered = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return order
      .map((id) => byId.get(id))
      .filter((t): t is Task => !!t && !removed.has(t.id))
      .map((t) => ({
        ...t,
        done: doneOverrides[t.id] ?? t.done,
        ...(fieldOverrides[t.id] ?? {}),
      }));
  }, [tasks, order, removed, doneOverrides, fieldOverrides]);

  const openCount = ordered.filter((t) => !t.done).length;
  const doneCount = ordered.length - openCount;
  const shown = ordered.filter((t) =>
    filter === "all" ? true : filter === "open" ? !t.done : t.done,
  );

  const canDrag = filter === "all" && editingId === null;
  const dragId = useRef<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  function onDragStart(e: React.DragEvent, id: number) {
    dragId.current = id;
    setDragging(id);
    // Required for the drag to actually start (Firefox won't drag without it).
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(id));
  }
  function onDragEnd() {
    dragId.current = null;
    setDragging(null);
  }
  function onDragOver(e: React.DragEvent, overId: number) {
    if (!canDrag || dragId.current == null) return;
    e.preventDefault(); // allow drop
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
        await reorderTasksAction(slug, finalOrder);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  }

  function toggle(task: Task, next: boolean) {
    setDoneOverrides((o) => ({ ...o, [task.id]: next }));
    startTransition(async () => {
      try {
        await toggleTaskAction(slug, task.id, next);
      } catch (err) {
        setDoneOverrides((o) => ({ ...o, [task.id]: task.done }));
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

  function remove(task: Task) {
    // Optimistically hide, then delete on the server after a short grace period
    // unless the user hits Undo first.
    setRemoved((r) => new Set(r).add(task.id));
    const timer = setTimeout(() => {
      deleteTimers.current.delete(task.id);
      startTransition(async () => {
        try {
          await deleteTaskAction(slug, task.id);
        } catch (err) {
          restore(task.id);
          toast.error(err instanceof Error ? err.message : String(err));
        }
      });
    }, 5000);
    deleteTimers.current.set(task.id, timer);
    toast("Task deleted", {
      duration: 5000,
      action: {
        label: "Undo",
        onClick: () => {
          const t = deleteTimers.current.get(task.id);
          if (t) clearTimeout(t);
          deleteTimers.current.delete(task.id);
          restore(task.id);
        },
      },
    });
  }

  function startEdit(task: {
    id: number;
    title: string;
    description: string | null;
  }) {
    setEditingId(task.id);
    setEditTitle(task.title);
    setEditDesc(task.description ?? "");
  }

  function saveEdit(taskId: number) {
    const title = editTitle.trim();
    if (!title) {
      toast.error("Title can't be empty");
      return;
    }
    const description = editDesc.trim() || null;
    setFieldOverrides((o) => ({ ...o, [taskId]: { title, description } }));
    setEditingId(null);
    startTransition(async () => {
      try {
        await updateTaskAction(slug, taskId, title, description);
        toast.success("Task updated");
      } catch (err) {
        setFieldOverrides((o) => {
          const next = { ...o };
          delete next[taskId];
          return next;
        });
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  }

  function onAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    if (!(formData.get("title") as string)?.trim()) return;
    startTransition(async () => {
      try {
        await addTaskAction(slug, formData);
        form.reset();
        toast.success("Task added");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <div className="space-y-4">
      <form ref={formRef} onSubmit={onAdd} className="space-y-2">
        <Input name="title" placeholder="New task…" required />
        <Textarea
          name="description"
          placeholder="Description (optional)…"
          rows={2}
          className="resize-y text-sm"
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={isPending}>
            Add task
          </Button>
        </div>
      </form>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {(["all", "open", "done"] as const).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? "default" : "outline"}
              className="h-7 px-2.5 capitalize"
              onClick={() => setFilter(f)}
            >
              {f}
            </Button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">
          {openCount} open · {doneCount} done
        </span>
      </div>

      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {ordered.length === 0 ? "No tasks yet." : `No ${filter} tasks.`}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {shown.map((t) =>
            editingId === t.id ? (
              <li key={t.id} className="rounded-md border px-3 py-2">
                <div className="space-y-2">
                  <Input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Title"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveEdit(t.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                  />
                  <Textarea
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                    placeholder="Description (optional)…"
                    rows={2}
                    className="resize-y text-sm"
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingId(null)}
                    >
                      Cancel
                    </Button>
                    <Button type="button" size="sm" onClick={() => saveEdit(t.id)}>
                      Save
                    </Button>
                  </div>
                </div>
              </li>
            ) : (
              <li key={t.id} className="rounded-md border">
                <div
                  onDragOver={(e) => onDragOver(e, t.id)}
                  onDrop={onDrop}
                  className={`group flex items-start gap-2 px-2 py-2 text-sm transition-opacity ${
                    dragging === t.id ? "opacity-40" : ""
                  }`}
                >
                {canDrag && (
                  <span
                    draggable
                    onDragStart={(e) => onDragStart(e, t.id)}
                    onDragEnd={onDragEnd}
                    aria-label="Drag to reorder"
                    className="mt-0.5 cursor-grab touch-none select-none text-muted-foreground/50 active:cursor-grabbing"
                  >
                    <GripVertical className="size-4" />
                  </span>
                )}
                <Checkbox
                  checked={t.done}
                  onCheckedChange={(v) => toggle(t, v === true)}
                  id={`task-${t.id}`}
                  className="mt-0.5"
                />
                <label
                  htmlFor={`task-${t.id}`}
                  className="min-w-0 flex-1 cursor-pointer"
                >
                  <span
                    className={
                      t.done
                        ? "text-muted-foreground line-through"
                        : "font-medium"
                    }
                  >
                    {t.title}
                  </span>
                  {t.description && (
                    <p
                      className={`mt-0.5 whitespace-pre-wrap text-xs ${
                        t.done
                          ? "text-muted-foreground/70 line-through"
                          : "text-muted-foreground"
                      }`}
                    >
                      {t.description}
                    </p>
                  )}
                  <span className="mt-0.5 block text-[11px] text-muted-foreground/70">
                    {formatRelativeTime(t.createdAt)}
                  </span>
                </label>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => startEdit(t)}
                    disabled={isPending}
                    aria-label="Edit task"
                    className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(t)}
                    disabled={isPending}
                    aria-label="Delete task"
                    className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
