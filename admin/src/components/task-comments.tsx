"use client";

import { FileText, Paperclip, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { addTaskCommentAction, deleteTaskCommentAction, notifyCommentAction, type CommentNotice } from "@/app/actions";
import { attachmentUrl, filesFromPaste, uploadTaskFiles } from "@/components/task-attachments";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { TaskAttachment, TaskComment } from "@/db/schema";
import { formatBytes, formatRelativeTime } from "@/lib/format";

/** Images shown as thumbnails (no SVG: it would run on the admin's origin). */
const IMAGE = (a: { mime: string }) => a.mime.startsWith("image/") && a.mime !== "image/svg+xml";

/** Say whether the ticket's agent was told about the comment. */
function reportNotice(notice: CommentNotice | null) {
  if (!notice?.terminal) return;
  if (notice.sent) {
    toast.success(
      (notice.queued
        ? `Sent to ${notice.terminal}: it reads it after its current turn`
        : `Sent to ${notice.terminal}`) + (notice.reopened ? " · the ticket is back in progress" : ""),
    );
  } else {
    toast.warning(`Comment saved, but ${notice.terminal} wasn't notified: ${notice.reason}`);
  }
}

/**
 * A task's comment thread. The user writes here, with images or other files
 * (paste a screenshot, drop files, or Attach); Claude answers through the
 * local-genie MCP (`add_task_comment`). A comment's files show under it.
 */
export function TaskComments({
  slug,
  taskId,
  comments,
  attachments = [],
}: {
  slug: string;
  taskId: number;
  comments: TaskComment[];
  /** the task's files; those with a commentId show under their comment */
  attachments?: TaskAttachment[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [isPending, startTransition] = useTransition();

  function submit() {
    const el = inputRef.current;
    const body = el?.value.trim() || (files.length ? "(files)" : "");
    if (!el || !body) return;
    const sending = files;
    startTransition(async () => {
      try {
        // With files: comment, upload them to it, then tell the agent (so it sees them).
        const { commentId, notice } = await addTaskCommentAction(slug, taskId, body, sending.length > 0);
        el.value = "";
        setFiles([]);
        if (sending.length) {
          await uploadTaskFiles(slug, taskId, sending, commentId);
          router.refresh();
          reportNotice(await notifyCommentAction(slug, taskId, commentId));
        } else {
          reportNotice(notice);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  }

  function remove(id: number) {
    startTransition(async () => {
      try {
        await deleteTaskCommentAction(slug, id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  }

  const addFiles = (list: File[]) => list.length && setFiles((f) => [...f, ...list]);

  return (
    <div className="space-y-2 border-t bg-muted/30 px-3 py-2">
      {comments.length > 0 && (
        <ul className="space-y-2">
          {comments.map((c) => {
            const mine = attachments.filter((a) => a.commentId === c.id);
            return (
              <li key={c.id} className="group/comment text-xs">
                <div className="flex items-center gap-1.5">
                  <span
                    className={
                      c.author === "claude"
                        ? "font-semibold text-orange-600 dark:text-orange-400"
                        : "font-semibold"
                    }
                  >
                    {c.author === "claude" ? "Claude" : "You"}
                  </span>
                  <span className="text-muted-foreground/70">
                    {formatRelativeTime(c.createdAt)}
                  </span>
                  <button
                    type="button"
                    onClick={() => remove(c.id)}
                    disabled={isPending}
                    aria-label="Delete comment"
                    className="ml-auto rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/comment:opacity-100 focus-visible:opacity-100"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
                {c.body !== "(files)" && (
                  <p className="mt-0.5 whitespace-pre-wrap text-foreground/90">
                    {c.body}
                  </p>
                )}
                {mine.length > 0 && (
                  <div className="mt-1 flex flex-wrap items-start gap-1.5">
                    {mine.map((a) =>
                      IMAGE(a) ? (
                        <a key={a.id} href={attachmentUrl(a.id)} target="_blank" rel="noreferrer" title={a.name}>
                          {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated API bytes, not a static asset */}
                          <img
                            src={attachmentUrl(a.id)}
                            alt={a.name}
                            className="h-20 max-w-40 rounded border bg-background object-cover"
                          />
                        </a>
                      ) : (
                        <a
                          key={a.id}
                          href={attachmentUrl(a.id)}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-1 rounded border bg-background px-1.5 py-0.5 hover:underline"
                        >
                          <FileText className="size-3 text-muted-foreground" />
                          {a.name}
                          <span className="text-muted-foreground">{formatBytes(a.size)}</span>
                        </a>
                      ),
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div
        className="space-y-1.5"
        onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          e.stopPropagation();
          addFiles([...e.dataTransfer.files]);
        }}
      >
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} className="flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-xs">
                {f.name}
                <span className="text-muted-foreground">{formatBytes(f.size)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => setFiles((all) => all.filter((_, j) => j !== i))}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            ref={inputRef}
            placeholder="Comment… paste or drop images to add them (Ctrl+Enter to send)"
            rows={1}
            className="min-h-8 resize-y bg-background text-xs md:text-xs"
            onPaste={(e) => {
              // A pasted screenshot goes with this comment, not to the ticket's files.
              const pasted = filesFromPaste(e);
              if (!pasted.length) return;
              e.preventDefault();
              e.stopPropagation();
              addFiles(pasted);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 px-2"
            aria-label="Attach files to the comment"
            title="Attach files to the comment"
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8"
            disabled={isPending}
            onClick={submit}
          >
            Comment
          </Button>
        </div>
      </div>
    </div>
  );
}
