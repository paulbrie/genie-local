"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { updateTaskAction } from "@/app/actions";
import { TaskAttachments, filesFromPaste, uploadTaskFiles } from "@/components/task-attachments";
import { TaskComments } from "@/components/task-comments";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  TASK_STATUSES,
  type Task,
  type TaskAttachment,
  type TaskComment,
  type TaskStatus,
} from "@/db/schema";
import { formatRelativeTime } from "@/lib/format";

export const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done",
};

/** One ticket: edit its fields, status and commit; its files and its comment thread. */
export function TaskDialog({
  slug,
  task,
  comments,
  attachments,
  onClose,
  onDelete,
}: {
  slug: string;
  task: Task;
  comments: TaskComment[];
  attachments: TaskAttachment[];
  onClose: () => void;
  onDelete: (task: Task) => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [status, setStatus] = useState<TaskStatus>(task.status as TaskStatus);
  const [commitSha, setCommitSha] = useState(task.commitSha ?? "");
  const [isPending, startTransition] = useTransition();

  const dirty =
    title !== task.title ||
    description !== (task.description ?? "") ||
    status !== task.status ||
    commitSha !== (task.commitSha ?? "");

  function save() {
    if (!title.trim()) {
      toast.error("Title can't be empty");
      return;
    }
    // Checked here too: in production server-action errors reach the client redacted.
    if (commitSha.trim() && !/^[0-9a-f]{4,64}$/i.test(commitSha.trim())) {
      toast.error("Commit must be a git sha (4 to 64 hex characters)");
      return;
    }
    startTransition(async () => {
      try {
        await updateTaskAction(slug, task.id, {
          title,
          description: description || null,
          status,
          commitSha: commitSha || null,
        });
        toast.success("Task updated");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  }

  function onPaste(e: React.ClipboardEvent) {
    const files = filesFromPaste(e);
    if (!files.length) return;
    e.preventDefault();
    startTransition(async () => {
      try {
        await uploadTaskFiles(slug, task.id, files);
        toast.success(`Pasted ${files.map((f) => f.name).join(", ")}`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        onPaste={onPaste}
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-baseline gap-2 pr-8">
            <span className="font-mono text-sm text-muted-foreground">#{task.id}</span>
            <span className="truncate">{task.title}</span>
          </DialogTitle>
          <DialogDescription>
            Created {formatRelativeTime(task.createdAt)} · updated{" "}
            {formatRelativeTime(task.updatedAt)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
            aria-label="Title"
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)…"
            aria-label="Description"
            rows={4}
            className="max-h-80 resize-y text-sm"
          />
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Status</Label>
              <Select value={status} onValueChange={(v) => v && setStatus(v as TaskStatus)}>
                <SelectTrigger size="sm" className="w-36" aria-label="Status">
                  <SelectValue>{(v: TaskStatus) => STATUS_LABEL[v]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {TASK_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-48 flex-1 space-y-1">
              <Label className="text-xs text-muted-foreground">
                Commit {status === "done" ? "" : "(when done)"}
              </Label>
              <Input
                value={commitSha}
                onChange={(e) => setCommitSha(e.target.value)}
                placeholder="sha, e.g. 4fc4a22"
                aria-label="Commit sha"
                className="h-8 font-mono text-xs"
              />
            </div>
            <Button size="sm" disabled={!dirty || isPending} onClick={save}>
              {isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>

        <section className="space-y-1.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Files ({attachments.length})
          </h3>
          <TaskAttachments slug={slug} taskId={task.id} attachments={attachments} />
        </section>

        <section className="space-y-1.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Comments ({comments.length})
          </h3>
          <div className="overflow-hidden rounded-md border">
            <TaskComments slug={slug} taskId={task.id} comments={comments} />
          </div>
        </section>

        <div className="flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => onDelete(task)}
          >
            <Trash2 className="size-3.5" />
            Delete task
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
