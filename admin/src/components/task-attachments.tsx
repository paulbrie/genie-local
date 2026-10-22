"use client";

import { FileText, Paperclip, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { deleteTaskAttachmentAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import type { TaskAttachment } from "@/db/schema";
import { BASE_PATH } from "@/lib/config";
import { formatBytes } from "@/lib/format";

export function attachmentUrl(id: number) {
  return `${BASE_PATH}/api/task-attachments/${id}`;
}

/** Upload files to a task (route handler: no server-action body limit). */
export async function uploadTaskFiles(
  slug: string,
  taskId: number,
  files: File[],
  /** the comment the files come with (shown under it); omitted = the ticket's own files */
  commentId?: number,
) {
  if (!files.length) return;
  const body = new FormData();
  for (const f of files) body.append("files", f);
  if (commentId != null) body.append("commentId", String(commentId));
  const res = await fetch(
    `${BASE_PATH}/api/projects/${encodeURIComponent(slug)}/tasks/${taskId}/attachments`,
    { method: "POST", body },
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `upload failed (${res.status})`);
  }
}

/** The longest description / comment kept inline (the server's own limit is 5000). */
export const TEXT_LIMIT = 5000;
const EXCERPT = 1500;

/**
 * Text too long for a ticket or comment (usually pasted data) is spilled to a
 * .txt attachment: the ticket keeps an excerpt and a note naming the file, so
 * it can still be saved, and agents read the whole text from the attachment.
 */
export function spillLongText(text: string, base: string): { text: string; file: File | null } {
  if (text.length <= TEXT_LIMIT) return { text, file: null };
  const name = `${base}-${stamp()}.txt`;
  return {
    text: `${text.slice(0, EXCERPT).trimEnd()}\n\n… ${text.length.toLocaleString("en")} characters in all: the full text is attached as ${name}.`,
    file: new File([text], name, { type: "text/plain" }),
  };
}

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

function isEditable(el: EventTarget | null) {
  return (
    el instanceof HTMLElement &&
    (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA")
  );
}

/**
 * The files a paste should attach: clipboard files (screenshots get a dated
 * name instead of "image.png"), or, when pasting outside a text field, the
 * clipboard text as a .txt file. Empty = let the paste through as normal.
 */
export function filesFromPaste(e: React.ClipboardEvent): File[] {
  const files = [...e.clipboardData.files].map((f) =>
    /^image\.\w+$/.test(f.name)
      ? new File([f], `pasted-${stamp()}.${f.name.split(".").pop()}`, { type: f.type })
      : f,
  );
  if (files.length) return files;
  const text = e.clipboardData.getData("text/plain");
  if (text && !isEditable(e.target)) {
    return [new File([text], `pasted-${stamp()}.txt`, { type: "text/plain" })];
  }
  return [];
}

/** A task's files: thumbnails for images, chips for the rest; add by picker, drop or paste. */
export function TaskAttachments({
  slug,
  taskId,
  attachments,
}: {
  slug: string;
  taskId: number;
  attachments: TaskAttachment[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isPending, startTransition] = useTransition();
  const [dragOver, setDragOver] = useState(false);

  function upload(files: File[]) {
    if (!files.length) return;
    startTransition(async () => {
      try {
        await uploadTaskFiles(slug, taskId, files);
        toast.success(files.length === 1 ? "File attached" : `${files.length} files attached`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  }

  function remove(id: number) {
    startTransition(async () => {
      try {
        await deleteTaskAttachmentAction(slug, id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  }

  const images = attachments.filter((a) => a.mime.startsWith("image/") && a.mime !== "image/svg+xml");
  const others = attachments.filter((a) => !images.includes(a));

  return (
    <div
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragOver(false);
        upload([...e.dataTransfer.files]);
      }}
      className={`space-y-2 rounded-md border border-dashed p-2 transition-colors ${
        dragOver ? "border-primary bg-primary/5" : ""
      }`}
    >
      {images.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {images.map((a) => (
            <div key={a.id} className="group/att relative">
              <a href={attachmentUrl(a.id)} target="_blank" rel="noreferrer" title={a.name}>
                {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated API bytes, not a static asset */}
                <img
                  src={attachmentUrl(a.id)}
                  alt={a.name}
                  className="aspect-video w-full rounded border bg-muted object-cover"
                />
              </a>
              <RemoveButton onClick={() => remove(a.id)} disabled={isPending} />
            </div>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <ul className="space-y-1">
          {others.map((a) => (
            <li key={a.id} className="group/att relative flex items-center gap-1.5 text-xs">
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <a
                href={attachmentUrl(a.id)}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 truncate hover:underline"
              >
                {a.name}
              </a>
              <span className="shrink-0 text-muted-foreground">{formatBytes(a.size)}</span>
              {a.author === "claude" && (
                <span className="shrink-0 text-orange-600 dark:text-orange-400">Claude</span>
              )}
              <RemoveButton onClick={() => remove(a.id)} disabled={isPending} inline />
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            upload([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7"
          disabled={isPending}
          onClick={() => inputRef.current?.click()}
        >
          <Paperclip className="size-3.5" />
          {isPending ? "Uploading…" : "Attach files"}
        </Button>
        <span className="text-xs text-muted-foreground">
          or drop files here, or paste (Ctrl+V) anywhere in this ticket
        </span>
      </div>
    </div>
  );
}

function RemoveButton({
  onClick,
  disabled,
  inline,
}: {
  onClick: () => void;
  disabled: boolean;
  inline?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Remove attachment"
      className={`rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/att:opacity-100 focus-visible:opacity-100 ${
        inline ? "ml-auto" : "absolute top-1 right-1 bg-background/80"
      }`}
    >
      <Trash2 className="size-3" />
    </button>
  );
}
