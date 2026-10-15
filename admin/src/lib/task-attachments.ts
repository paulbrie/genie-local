import "server-only";

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Files attached to tasks live on disk (not in the DB) so agents can open them
 * by path: <root>/<taskId>/<random>-<name>. The DB row keeps the relative path.
 */
export const ATTACHMENTS_ROOT = path.resolve(
  process.env.TASK_ATTACHMENTS_DIR ?? "/opt/project/.task-attachments",
);
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Types the browser may render inline; anything else downloads (no HTML/SVG on the admin origin). */
const INLINE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/pdf",
  "text/plain",
]);

export function isInlineType(mime: string): boolean {
  return INLINE_TYPES.has(mime);
}

export function safeFileName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ]+/g, "_").trim();
  return base.slice(-120) || "file";
}

/** Absolute path of a stored attachment; throws if `rel` escapes the root. */
export function attachmentAbsPath(rel: string): string {
  const abs = path.resolve(ATTACHMENTS_ROOT, rel);
  if (!abs.startsWith(ATTACHMENTS_ROOT + path.sep)) {
    throw new Error("attachment path outside the attachments dir");
  }
  return abs;
}

export async function saveAttachment(taskId: number, file: File) {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${file.name} is over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
  }
  const name = safeFileName(file.name);
  const rel = path.join(String(taskId), `${randomBytes(4).toString("hex")}-${name}`);
  const abs = attachmentAbsPath(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, Buffer.from(await file.arrayBuffer()));
  return {
    name,
    mime: file.type || "application/octet-stream",
    size: file.size,
    path: rel,
  };
}

export async function removeAttachmentFile(rel: string) {
  await fs.rm(attachmentAbsPath(rel), { force: true });
}

/** Remove every file of a task (after the task row is deleted). */
export async function removeTaskAttachmentDir(taskId: number) {
  await fs.rm(attachmentAbsPath(String(taskId)), { recursive: true, force: true });
}
