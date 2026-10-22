"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { updateTaskAction } from "@/app/actions";
import { TaskAttachments, filesFromPaste, spillLongText, uploadTaskFiles } from "@/components/task-attachments";
import { TaskComments } from "@/components/task-comments";
import { TaskDelegate } from "@/components/task-delegate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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

/**
 * One ticket in a drawer from the right: edit its fields, status and commit;
 * its files and its comment thread.
 */
export function TaskDrawer({
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
  // Closed here first so the drawer slides out, then unmounted via onClose.
  const [open, setOpen] = useState(true);
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
    // A too-long description (pasted data) goes to a .txt attachment; the ticket keeps an excerpt.
    const spilled = spillLongText(description, "description");
    startTransition(async () => {
      try {
        await updateTaskAction(slug, task.id, {
          title,
          description: spilled.text || null,
          status,
          commitSha: commitSha || null,
        });
        if (spilled.file) {
          await uploadTaskFiles(slug, task.id, [spilled.file]);
          setDescription(spilled.text);
          router.refresh();
          toast.success(`Task updated; its long description is attached as ${spilled.file.name}`);
        } else {
          toast.success("Task updated");
        }
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
    <Sheet
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(o) => !o && onClose()}
    >
      <SheetContent
        side="right"
        onPaste={onPaste}
        className="flex w-full flex-col gap-0 data-[side=right]:sm:max-w-xl"
      >
        <SheetHeader className="border-b pr-10">
          <SheetTitle className="flex items-baseline gap-2">
            <span className="font-mono text-sm text-muted-foreground">#{task.id}</span>
            <span className="truncate">{task.title}</span>
          </SheetTitle>
          <SheetDescription>
            {STATUS_LABEL[task.status as TaskStatus]} · created{" "}
            {formatRelativeTime(task.createdAt)} · updated{" "}
            {formatRelativeTime(task.updatedAt)}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
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
              Delegate
            </h3>
            <TaskDelegate slug={slug} task={task} />
          </section>

          <section className="space-y-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Files ({attachments.filter((a) => a.commentId == null).length})
            </h3>
            {/* the ticket's own files; a comment's show under it in the thread */}
            <TaskAttachments slug={slug} taskId={task.id} attachments={attachments.filter((a) => a.commentId == null)} />
          </section>

          <section className="space-y-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Comments ({comments.length})
            </h3>
            <div className="overflow-hidden rounded-md border">
              <TaskComments slug={slug} taskId={task.id} comments={comments} attachments={attachments} />
            </div>
          </section>
        </div>

        <div className="flex justify-end border-t p-3">
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
      </SheetContent>
    </Sheet>
  );
}
