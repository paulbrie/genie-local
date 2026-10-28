// GET /api/files?op=…: the explorer's reads; POST /api/files {op, …}: its changes (T243). Admin-only (src/proxy.ts:
// the session; a change must come from this origin). Every path is checked against the roots (lib/files/guard): those
// of the request's scope, a project's folder alone when it names one (`project`, the project's Files tab).
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

import { openForEdit, writeText } from "@/lib/files/edit";
import { assertWritable, isPseudo, PathError, resolveExisting, rootOf, scopeRoots, writeRoots } from "@/lib/files/guard";
import { isSecretPath, listDir } from "@/lib/files/listing";
import { audit, deletePath, makeFolder, movePath, planDelete, renamePath } from "@/lib/files/ops";
import { readPage } from "@/lib/files/preview";
import { emptyTrash, listTrash, restoreFromTrash, trashDir } from "@/lib/files/trash";
import { CHUNK_BYTES } from "@/lib/files/uploads";
import { errorResponse, whoOf } from "./shared";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams, op = q.get("op") ?? "list";
  try {
    const roots = scopeRoots(q.get("project"));
    if (op === "roots") return NextResponse.json({ roots, writeRoots: writeRoots(), trash: trashDir(), chunkBytes: CHUNK_BYTES });
    // (scoped: only what was deleted from inside the project)
    if (op === "trash") return NextResponse.json({ items: (await listTrash()).filter((i) => rootOf(path.resolve(i.originalPath), roots)) });
    const t = await resolveExisting(q.get("path") ?? "", roots);
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
    if (op === "plan-delete") return NextResponse.json(await planDelete(t.abs, roots));
    if (op === "read") {
      if (isPseudo(t.abs)) return NextResponse.json({ error: "a kernel file (/proc, /sys): not read from here" }, { status: 403 });
      // (a credential file: only when asked for, per file; the audit line names the path, never the contents)
      const secret = isSecretPath(t.abs);
      if (secret && q.get("reveal") !== "1") return NextResponse.json({ secret: true, error: "a credential file: its contents are shown on request" }, { status: 403 });
      const st = await fs.stat(t.abs);
      if (!st.isFile()) return NextResponse.json({ error: "not a regular file" }, { status: 400 });
      const offset = Math.max(0, Number(q.get("offset")) || 0), m = q.get("mode");
      if (secret && offset === 0) audit("secret-viewed", { path: t.abs }, whoOf(req));
      const mode = m === "text" || m === "hex" ? m : undefined;
      if (offset > 0 || mode === "hex") return NextResponse.json(await readPage(t.abs, offset, mode));
      // (the first page: a file the editor can open comes whole, with the hash a save must still find; else why not)
      const e = await openForEdit(t.abs);
      if ("readOnly" in e) return NextResponse.json({ ...(await readPage(t.abs, 0, mode)), readOnly: e.readOnly });
      return NextResponse.json({ mode: "text", text: e.text, size: e.size, offset: 0, next: e.size, editable: true, mtime: e.mtime, hash: e.hash });
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
    const roots = scopeRoots(s("project"));
    switch (body.op) {
      case "mkdir": {
        const p = await makeFolder(s("dir"), s("name"), roots);
        audit("mkdir", { path: p }, who);
        return NextResponse.json({ path: p });
      }
      case "rename": {
        const p = await renamePath(s("path"), s("name"), roots);
        audit("rename", { from: s("path"), to: p }, who);
        return NextResponse.json({ path: p });
      }
      case "move": {
        const p = await movePath(s("path"), s("to"), roots);
        audit("move", { from: s("path"), to: p }, who);
        return NextResponse.json({ path: p });
      }
      case "delete": {
        const item = await deletePath(s("path"), body.force === true, roots);
        audit("delete", { path: item.originalPath, bytes: item.bytes, trash: item.id, force: body.force === true }, who);
        return NextResponse.json({ item });
      }
      case "restore": {
        // (back inside the roots only, checked before it moves: an entry's record could have been edited on disk)
        const entry = (await listTrash()).find((i) => i.id === s("id"));
        if (!entry) return NextResponse.json({ error: "not in the trash" }, { status: 404 });
        if (!rootOf(path.resolve(entry.originalPath), roots)) return NextResponse.json({ error: "outside the roots" }, { status: 403 });
        await assertWritable(path.dirname(path.resolve(entry.originalPath)));
        const item = await restoreFromTrash(entry.id);
        audit("restore", { path: item.originalPath, bytes: item.bytes }, who);
        return NextResponse.json({ item });
      }
      case "write": {
        const r = await writeText(s("path"), body.content, s("hash"), roots);
        audit("write", { path: r.path, bytes: r.size }, who);
        return NextResponse.json(r);
      }
      case "empty-trash": {
        // (the whole trash: not from a project's view, which sees only its own part of it)
        if (s("project")) throw new PathError("the trash is emptied from Files, where all of it shows", 403);
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
