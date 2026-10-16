"use client";

import { GitCommitHorizontal, MessageSquare, Paperclip, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { addTaskAction, deleteTaskAction, moveTaskAction } from "@/app/actions";
import { filesFromPaste, uploadTaskFiles } from "@/components/task-attachments";
import { STATUS_LABEL, TaskDrawer } from "@/components/task-drawer";
import { useTaskLive } from "@/components/use-task-live";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { Textarea } from "@/components/ui/textarea";
import {
  TASK_STATUSES,
  type Task,
  type TaskAttachment,
  type TaskComment,
  type TaskStatus,
} from "@/db/schema";
import { formatBytes, formatRelativeTime } from "@/lib/format";

/** A drag in progress (or a drop being saved): the board as it will be. */
type Draft = { order: number[]; status: Record<number, TaskStatus> };

function groupBy<T extends { taskId: number }>(rows: T[]) {
  const map = new Map<number, T[]>();
  for (const r of rows) {
    const list = map.get(r.taskId);
    if (list) list.push(r);
    else map.set(r.taskId, [r]);
  }
  return map;
}

/**
 * The project's tasks as a kanban board (Open / In progress / Done). Drag a
 * card to reorder it or move it to another column; click it to open the ticket
 * (fields, status, commit, files, comments).
 */
export function TaskBoard({
  slug,
  tasks,
  comments,
  attachments,
}: {
  slug: string;
  tasks: Task[];
  comments: TaskComment[];
  attachments: TaskAttachment[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const commentsByTask = useMemo(() => groupBy(comments), [comments]);
  const attachmentsByTask = useMemo(() => groupBy(attachments), [attachments]);

  // --- new task form (files picked, dropped or pasted wait here until created)
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [newFiles, setNewFiles] = useState<File[]>([]);

  function onAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    if (!(formData.get("title") as string)?.trim()) return;
    const files = newFiles;
    startTransition(async () => {
      try {
        const taskId = await addTaskAction(slug, formData);
        if (files.length) {
          await uploadTaskFiles(slug, taskId, files);
          router.refresh();
        }
        form.reset();
        setNewFiles([]);
        toast.success(`Task #${taskId} added`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  }

  // --- optimistic delete with a 5 s undo window
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const deleteTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const timers = deleteTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
    };
  }, []);

  function restore(id: number) {
    setRemoved((r) => {
      const next = new Set(r);
      next.delete(id);
      return next;
    });
  }

  function remove(task: Task) {
    setOpenId(null);
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
    toast(`Task #${task.id} deleted`, {
      duration: 5000,
      action: {
        label: "Undo",
        onClick: () => {
          clearTimeout(deleteTimers.current.get(task.id));
          deleteTimers.current.delete(task.id);
          restore(task.id);
        },
      },
    });
  }

  // --- drag and drop
  const [draft, setDraft] = useState<Draft | null>(null);
  const dragId = useRef<number | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const dropped = useRef(false);
  // Live updates from elsewhere wait while a card is being dragged.
  const { live, flush } = useTaskLive(slug, () => dragId.current != null);

  const visible = useMemo(() => {
    const live = tasks.filter((t) => !removed.has(t.id));
    if (!draft) return live;
    const rank = new Map(draft.order.map((id, i) => [id, i]));
    return live
      .map((t) => ({ ...t, status: draft.status[t.id] ?? t.status }))
      .sort((a, b) => (rank.get(a.id) ?? -1) - (rank.get(b.id) ?? -1));
  }, [tasks, removed, draft]);

  const columns = useMemo(() => {
    const cols: Record<TaskStatus, Task[]> = { open: [], in_progress: [], done: [] };
    for (const t of visible) (cols[t.status as TaskStatus] ?? cols.open).push(t);
    return cols;
  }, [visible]);

  function onDragStart(e: React.DragEvent, id: number) {
    dragId.current = id;
    setDraggingId(id);
    dropped.current = false;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(id)); // Firefox needs data to drag
    setDraft({ order: visible.map((t) => t.id), status: {} });
  }

  function onDragEnd() {
    dragId.current = null;
    setDraggingId(null);
    if (!dropped.current) {
      setDraft(null);
      flush();
    }
  }

  /** Move the dragged card into `status`, before `beforeId` (or to the column's end). */
  function moveDragged(status: TaskStatus, beforeId: number | null) {
    const from = dragId.current;
    if (from == null || from === beforeId) return;
    setDraft((d) => {
      if (!d) return d;
      const statusOf = (id: number) =>
        d.status[id] ?? (tasks.find((t) => t.id === id)?.status as TaskStatus);
      if (beforeId == null && statusOf(from) === status) return d;
      const order = d.order.filter((id) => id !== from);
      let at: number;
      if (beforeId != null) {
        at = order.indexOf(beforeId);
      } else {
        const lastInCol = order.findLastIndex((id) => statusOf(id) === status);
        at = lastInCol + 1 || order.length;
      }
      order.splice(at < 0 ? order.length : at, 0, from);
      const next = { order, status: { ...d.status, [from]: status } };
      return next.order.join() === d.order.join() && statusOf(from) === status ? d : next;
    });
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const id = dragId.current;
    if (id == null || !draft) return;
    dropped.current = true;
    const original = tasks.find((t) => t.id === id);
    const status = draft.status[id] ?? (original?.status as TaskStatus);
    const order = draft.order;
    startTransition(async () => {
      try {
        await moveTaskAction(slug, id, status, order);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setDraft(null);
        flush();
      }
    });
  }

  // --- the open ticket
  const [openId, setOpenId] = useState<number | null>(null);
  const openTask = openId == null ? null : tasks.find((t) => t.id === openId);

  return (
    <div className="space-y-4">
      <form
        ref={formRef}
        onSubmit={onAdd}
        onPaste={(e) => {
          const files = filesFromPaste(e);
          if (!files.length) return;
          e.preventDefault();
          setNewFiles((f) => [...f, ...files]);
        }}
        onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setNewFiles((f) => [...f, ...e.dataTransfer.files]);
        }}
        className="space-y-2"
      >
        <Input name="title" placeholder="New task…" required />
        <Textarea
          name="description"
          placeholder="Description (optional)… paste or drop files to attach them"
          rows={2}
          className="resize-y text-sm"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const picked = [...(e.target.files ?? [])];
              setNewFiles((f) => [...f, ...picked]);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip className="size-3.5" />
            Attach files
          </Button>
          {newFiles.map((f, i) => (
            <span
              key={`${f.name}-${i}`}
              className="flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs"
            >
              {f.name}
              <span className="text-muted-foreground">{formatBytes(f.size)}</span>
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => setNewFiles((all) => all.filter((_, j) => j !== i))}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          <Button type="submit" size="sm" className="ml-auto" disabled={isPending}>
            Add task
          </Button>
        </div>
      </form>

      <div className="-mb-2 flex justify-end">
        <span
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
          title={live ? "Changes from anywhere show up here as they happen" : "Reconnecting to live updates…"}
        >
          <StatusDot
            color={live ? "bg-emerald-500" : "bg-amber-500"}
            pulse={live}
            label={live ? "Live" : "Reconnecting"}
          />
          {live ? "Live" : "Reconnecting…"}
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {TASK_STATUSES.map((status) => (
          <section
            key={status}
            data-column={status}
            onDragOver={(e) => {
              if (dragId.current == null) return;
              e.preventDefault();
              moveDragged(status, null);
            }}
            onDrop={onDrop}
            className="flex min-h-40 flex-col gap-2 rounded-lg bg-muted/50 p-2"
          >
            <h3 className="flex items-center justify-between px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {STATUS_LABEL[status]}
              <span className="tabular-nums">{columns[status].length}</span>
            </h3>
            {columns[status].map((t) => (
              <TaskCard
                key={t.id}
                slug={slug}
                task={t}
                comments={commentsByTask.get(t.id)}
                attachmentCount={attachmentsByTask.get(t.id)?.length ?? 0}
                dragging={draggingId === t.id}
                onOpen={() => setOpenId(t.id)}
                onDragStart={(e) => onDragStart(e, t.id)}
                onDragEnd={onDragEnd}
                onDragOver={(e) => {
                  if (dragId.current == null) return;
                  e.preventDefault();
                  e.stopPropagation();
                  moveDragged(status, t.id);
                }}
              />
            ))}
          </section>
        ))}
      </div>

      {openTask && (
        <TaskDrawer
          key={openTask.id}
          slug={slug}
          task={openTask}
          comments={commentsByTask.get(openTask.id) ?? []}
          attachments={attachmentsByTask.get(openTask.id) ?? []}
          onClose={() => setOpenId(null)}
          onDelete={remove}
        />
      )}
    </div>
  );
}

function TaskCard({
  slug,
  task,
  comments,
  attachmentCount,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
  onDragOver,
}: {
  slug: string;
  task: Task;
  comments: TaskComment[] | undefined;
  attachmentCount: number;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
}) {
  const commentCount = comments?.length ?? 0;
  // Orange when Claude had the last word: a reply is waiting to be read.
  const claudeLast = comments?.at(-1)?.author === "claude";
  const done = task.status === "done";

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      data-task={task.id}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      className={`cursor-pointer space-y-1 rounded-md border bg-card p-2 text-sm shadow-xs transition hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none ${
        dragging ? "opacity-40" : ""
      }`}
    >
      <div className="flex gap-1.5">
        <span className="shrink-0 font-mono text-xs leading-5 text-muted-foreground tabular-nums">
          #{task.id}
        </span>
        <span className={`min-w-0 font-medium ${done ? "text-muted-foreground" : ""}`}>
          {task.title}
        </span>
      </div>
      {task.description && (
        <p className="line-clamp-3 text-xs whitespace-pre-wrap text-muted-foreground">
          {task.description}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
        <span>{formatRelativeTime(task.updatedAt)}</span>
        {commentCount > 0 && (
          <span
            className={`flex items-center gap-0.5 ${
              claudeLast ? "font-medium text-orange-600 dark:text-orange-400" : ""
            }`}
            title={claudeLast ? "Claude replied" : "Comments"}
          >
            <MessageSquare className="size-3" />
            {commentCount}
          </span>
        )}
        {attachmentCount > 0 && (
          <span className="flex items-center gap-0.5" title="Files">
            <Paperclip className="size-3" />
            {attachmentCount}
          </span>
        )}
        {task.commitSha && (
          <Link
            href={`/projects/${encodeURIComponent(slug)}?tab=git&commit=${task.commitSha}`}
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-0.5 font-mono hover:text-foreground hover:underline"
            title="Open the commit in the Git tab"
          >
            <GitCommitHorizontal className="size-3" />
            {task.commitSha.slice(0, 7)}
          </Link>
        )}
      </div>
    </div>
  );
}
