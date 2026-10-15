"use client";

import { Trash2 } from "lucide-react";
import { useRef, useTransition } from "react";
import { toast } from "sonner";

import { addTaskCommentAction, deleteTaskCommentAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { TaskComment } from "@/db/schema";
import { formatRelativeTime } from "@/lib/format";

/**
 * A task's comment thread. The user writes here; Claude answers through the
 * local-genie MCP (`add_task_comment`), so its replies show up on the next
 * render of the page.
 */
export function TaskComments({
  slug,
  taskId,
  comments,
}: {
  slug: string;
  taskId: number;
  comments: TaskComment[];
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    const el = inputRef.current;
    const body = el?.value.trim();
    if (!el || !body) return;
    startTransition(async () => {
      try {
        await addTaskCommentAction(slug, taskId, body);
        el.value = "";
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

  return (
    <div className="space-y-2 border-t bg-muted/30 px-3 py-2">
      {comments.length > 0 && (
        <ul className="space-y-2">
          {comments.map((c) => (
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
              <p className="mt-0.5 whitespace-pre-wrap text-foreground/90">
                {c.body}
              </p>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          ref={inputRef}
          placeholder="Comment… (Ctrl+Enter to send)"
          rows={1}
          className="min-h-8 resize-y bg-background text-xs md:text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
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
  );
}
