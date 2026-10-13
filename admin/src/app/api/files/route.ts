// GET /api/files?op=…: the explorer's reads; POST /api/files {op, …}: its changes (T243). Admin-only (src/proxy.ts:
// the session; a change must come from this origin). Every path is checked against the roots (lib/files/guard).
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

import { assertWritable, fileRoots, isPseudo, resolveExisting, rootOf, writeRoots } from "@/lib/files/guard";
import { isSecretPath, listDir } from "@/lib/files/listing";
import { audit, deletePath, makeFolder, movePath, planDelete, renamePath } from "@/lib/files/ops";
import { emptyTrash, listTrash, restoreFromTrash, trashDir } from "@/lib/files/trash";
import { CHUNK_BYTES } from "@/lib/files/uploads";
import { errorResponse, whoOf } from "./shared";

export const dynamic = "force-dynamic";

/** a text preview: up to this much, and only if it looks like text */
const PREVIEW_BYTES = 1024 * 1024;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams, op = q.get("op") ?? "list";
  try {
    if (op === "roots") return NextResponse.json({ roots: fileRoots(), writeRoots: writeRoots(), trash: trashDir(), chunkBytes: CHUNK_BYTES });
    if (op === "trash") return NextResponse.json({ items: await listTrash() });
    const t = await resolveExisting(q.get("path") ?? "");
    if (op === "list") {
      const st = await fs.stat(t.abs);
      if (!st.isDirectory()) return NextResponse.json({ error: "not a folder" }, { status: 400 });
      const parent = t.abs === t.root ? null : path.dirname(t.abs);
      // (a folder genie can't read: shown as such, not as an error)
      const entries = await listDir(t.abs).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "EACCES" || err.code === "EPERM") return null;
        throw err;
      });
      return NextResponse.json({ path: t.abs, root: t.root, parent, entries: entries ?? [], noPermission: entries === null });
    }
    if (op === "plan-delete") return NextResponse.json(await planDelete(t.abs));
    if (op === "read") {
      if (isPseudo(t.abs)) return NextResponse.json({ error: "a kernel file (/proc, /sys): not read from here" }, { status: 403 });
      // (a credential file: only when asked for, per file; the audit line names the path, never the contents)
      const secret = isSecretPath(t.abs);
      if (secret && q.get("reveal") !== "1") return NextResponse.json({ secret: true, error: "a credential file: its contents are shown on request" }, { status: 403 });
      const st = await fs.stat(t.abs);
      if (!st.isFile()) return NextResponse.json({ error: "not a regular file" }, { status: 400 });
      if (secret) audit("secret-viewed", { path: t.abs }, whoOf(req));
      const fh = await fs.open(t.abs, "r");
      try {
        const buf = Buffer.alloc(Math.min(st.size, PREVIEW_BYTES));
        await fh.read(buf, 0, buf.length, 0);
        // (a NUL in the first 8 KB: binary, no text preview)
        if (buf.subarray(0, 8192).includes(0)) return NextResponse.json({ binary: true, size: st.size });
        return NextResponse.json({ text: buf.toString("utf8"), size: st.size, truncated: st.size > PREVIEW_BYTES });
      } finally {
        await fh.close();
      }
    }
    return NextResponse.json({ error: "unknown op" }, { status: 400 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  const who = whoOf(req);
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const s = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
    switch (body.op) {
      case "mkdir": {
        const p = await makeFolder(s("dir"), s("name"));
        audit("mkdir", { path: p }, who);
        return NextResponse.json({ path: p });
      }
      case "rename": {
        const p = await renamePath(s("path"), s("name"));
        audit("rename", { from: s("path"), to: p }, who);
        return NextResponse.json({ path: p });
      }
      case "move": {
        const p = await movePath(s("path"), s("to"));
        audit("move", { from: s("path"), to: p }, who);
        return NextResponse.json({ path: p });
      }
      case "delete": {
        const item = await deletePath(s("path"), body.force === true);
        audit("delete", { path: item.originalPath, bytes: item.bytes, trash: item.id, force: body.force === true }, who);
        return NextResponse.json({ item });
      }
      case "restore": {
        // (back inside the roots only, checked before it moves: an entry's record could have been edited on disk)
        const entry = (await listTrash()).find((i) => i.id === s("id"));
        if (!entry) return NextResponse.json({ error: "not in the trash" }, { status: 404 });
        if (!rootOf(path.resolve(entry.originalPath), fileRoots())) return NextResponse.json({ error: "outside the roots" }, { status: 403 });
        await assertWritable(path.dirname(path.resolve(entry.originalPath)));
        const item = await restoreFromTrash(entry.id);
        audit("restore", { path: item.originalPath, bytes: item.bytes }, who);
        return NextResponse.json({ item });
      }
      case "empty-trash": {
        const r = await emptyTrash();
        audit("empty-trash", { items: r.items, bytes: r.bytes }, who);
        return NextResponse.json(r);
      }
      default:
        return NextResponse.json({ error: "unknown op" }, { status: 400 });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
