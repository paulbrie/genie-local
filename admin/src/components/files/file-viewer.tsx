"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, FileLock, Loader2, Lock, Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/lib/ask";
import { API, api, type Entry, IMAGE, PDF, postTo, pseudo, rawUrl, when } from "./files-api";
import type { EditorControls } from "./monaco-viewer";
import { formatBytes } from "./upload-list";

const MonacoViewer = dynamic(() => import("./monaco-viewer"), { ssr: false, loading: () => <p className="p-3 text-xs text-muted-foreground">Loading the viewer…</p> });

/**
 * a page of a file's preview, as the API sends it (lib/files/preview); the first page also says whether the file can be
 * edited (then it is the whole file, with the hash a save must still find on disk: lib/files/edit) or why not
 */
type Page = { mode: "text" | "hex"; text: string; size: number; offset: number; next: number; editable?: boolean; readOnly?: string; hash?: string; mtime?: number };
/** what the preview holds: the pages so far (`next` = bytes shown), for a credential file only once revealed */
type Preview = {
  text?: string; mode?: "text" | "hex"; size?: number; next?: number; reveal?: boolean; more?: boolean; moreError?: string; error?: string; secret?: boolean; revealing?: boolean;
  editable?: boolean; readOnly?: string; hash?: string; mtime?: number;
  /** which read this is (an editor opens afresh with each) */
  load?: number;
};
/** "Load all" asks first when more than this is left: it all goes into the browser */
const LOAD_ALL_ASK = 100 * 1024 * 1024;
const readUrl = (scope: string, p: string, offset: number, mode?: string, reveal?: boolean) =>
  `${API}?op=read&path=${encodeURIComponent(p)}&offset=${offset}${mode ? `&mode=${mode}` : ""}${reveal ? "&reveal=1" : ""}${scope}`;

/**
 * One file, viewed in full (T243; the explorer's file windows draw it): any size, a page at a time (text in a read-only
 * Monaco, binary as hex, "Load more" / "Load all"), images, PDFs, a credential file's contents on request. A text file
 * the server lets change opens in an editor instead: Save (Ctrl/Cmd+S, from anywhere on the page while `active`),
 * refused if it changed on disk meanwhile, then offered a reload from disk. It reports unsaved changes (`onDirty`) and
 * what a save left on disk (`onSaved`), so the explorer can guard and refresh. `scope` / `project`: a project's Files tab
 * ("&project=<slug>" / its slug: the server holds each request to that project).
 */
export function FileViewer({ entry, scope, project, active = false, onDirty, onSaved }: {
  entry: Entry;
  scope: string;
  project?: string;
  active?: boolean;
  onDirty?: (dirty: boolean) => void;
  onSaved?: (r: { size: number; mtime: number }) => void;
}) {
  const { path, name, secret } = entry;
  const media = !secret && (IMAGE.test(name) || PDF.test(name));
  const [preview, setPreview] = useState<Preview | null>(null);
  // (read when shown; a credential file's contents only after "Show contents"; `reloads`: read it again, after a
  // refused save)
  const [reloads, setReloads] = useState(0);
  const reads = useRef(0), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (media || pseudo(path)) return;
    if (secret) { setPreview({ secret: true }); return; }
    let live = true;
    setPreview(null);
    api<Page>(readUrl(scope, path, 0))
      .then((r) => live && setPreview({ ...r, load: ++reads.current }), (err) => live && setPreview({ error: (err as Error).message }));
    return () => { live = false; };
  }, [path, secret, media, scope, reloads]);

  // The editor (a file the server lets change): unsaved changes, as Monaco reports them for the read it opened with.
  const editing = !!preview?.editable && !!preview.hash;
  const editorKey = `${path}#${preview?.load ?? 0}`;
  const [changes, setChanges] = useState<{ key: string; dirty: boolean } | null>(null);
  const dirty = editing && changes?.key === editorKey && changes.dirty;
  const reportDirty = useRef(onDirty);
  useEffect(() => { reportDirty.current = onDirty; });
  useEffect(() => { reportDirty.current?.(dirty); }, [dirty]);
  const [saving, setSaving] = useState(false);
  const controls = useRef<EditorControls | null>(null);
  const post = <T,>(body: object) => postTo<T>(project ? { ...body, project } : body);
  const save = async (text: string): Promise<boolean> => {
    const p0 = preview;
    if (!p0?.editable || !p0.hash) return false;
    setSaving(true);
    try {
      const r = await post<{ path: string; size: number; mtime: number; hash: string }>({ op: "write", path, content: text, hash: p0.hash });
      setPreview((p) => (p?.load === p0.load ? { ...p, text, size: r.size, next: r.size, hash: r.hash, mtime: r.mtime } : p));
      toast.success(`Saved ${name}`);
      onSaved?.({ size: r.size, mtime: r.mtime });
      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 409) {
        const reload = await confirmDialog(
          `${name} changed on disk since it was opened, so it wasn't saved. Reload it from disk? The changes made here are then lost; cancel keeps them, to copy them first.`,
          { title: "Changed on disk", confirmLabel: "Reload from disk", destructive: true },
        );
        if (reload && alive.current) { setChanges(null); setReloads((n) => n + 1); }
      } else toast.error(`Not saved: ${(err as Error).message}`);
      return false;
    } finally {
      if (alive.current) setSaving(false);
    }
  };
  // (Ctrl/Cmd+S saves with the focus anywhere on the page, not only in the editor, which handles it itself: the frontmost
  // window's file)
  useEffect(() => {
    if (!editing || !active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      controls.current?.save();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, active]);

  const reveal = () => {
    setPreview({ secret: true, revealing: true });
    api<Page>(readUrl(scope, path, 0, undefined, true))
      .then((r) => alive.current && setPreview({ ...r, reveal: true }), (err) => alive.current && setPreview({ secret: true, error: (err as Error).message }));
  };
  /** the preview's next page, or (`all`) every page left until the end or "Stop"; appended, the viewer keeps its place */
  const stopLoading = useRef(false);
  const loadMore = useCallback(async (all: boolean) => {
    const p0 = preview;
    if (!p0 || p0.next == null || p0.size == null || p0.more) return;
    const left = p0.size - p0.next;
    if (all && left > LOAD_ALL_ASK && !(await confirmDialog(`Load the remaining ${formatBytes(left)} into the browser? A file this big can make this tab slow, or crash it.`, { confirmLabel: "Load it all" }))) return;
    stopLoading.current = false;
    setPreview((p) => (p ? { ...p, more: true, moreError: undefined } : p));
    let next = p0.next, size = p0.size;
    try {
      do {
        const r = await api<Page>(readUrl(scope, path, next, p0.mode, p0.reveal));
        if (r.next <= next) break; // (nothing new: the file shrank)
        next = r.next;
        size = r.size;
        setPreview((p) => (p ? { ...p, text: (p.text ?? "") + (p.mode === "hex" ? "\n" : "") + r.text, next: r.next, size: r.size } : p));
      } while (all && next < size && !stopLoading.current && alive.current);
    } catch (err) {
      setPreview((p) => (p ? { ...p, moreError: (err as Error).message } : p));
    } finally {
      setPreview((p) => (p ? { ...p, more: false } : p));
    }
  }, [preview, scope, path]);

  // (the file's size and time: as last read or saved, which can be newer than the listing)
  const shown = preview?.size != null && preview.mtime != null
    ? { size: preview.size, modified: new Date(preview.mtime).toISOString() }
    : { size: entry.size, modified: entry.modified };
  const partial = (preview?.next ?? 0) < (preview?.size ?? 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {preview && !preview.error && !preview.secret && (editing || preview.readOnly || preview.mode === "hex" || partial) && (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
          <span className="mr-auto">
            {preview.mode === "hex" && "A binary file, as hex. "}
            {partial ? `The first ${formatBytes(preview.next ?? 0)} of ${formatBytes(preview.size ?? 0)}.` : preview.mode === "hex" ? `All ${formatBytes(preview.size ?? 0)}.` : ""}
          </span>
          {preview.moreError && <span className="text-destructive">{preview.moreError}</span>}
          {preview.more ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground" onClick={() => { stopLoading.current = true; }}>Stop</button>
            </>
          ) : partial && (
            <>
              <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground" onClick={() => void loadMore(false)}>Load more</button>
              <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground" onClick={() => void loadMore(true)}>Load all</button>
            </>
          )}
          {editing ? (
            <Button size="sm" className="h-7" disabled={!dirty || saving} title="Save (Ctrl+S)" onClick={() => controls.current?.save()}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save
            </Button>
          ) : preview.readOnly && preview.mode === "text" && (
            <span className="flex items-center gap-1" title={`Read-only: ${preview.readOnly}`}><Lock className="size-3.5" /> Read-only</span>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {pseudo(path) ? <p className="p-4 text-sm text-muted-foreground">A kernel file (/proc, /sys): listed here, not read.</p>
          // eslint-disable-next-line @next/next/no-img-element -- (the admin's own API, behind its session: not for the image optimizer)
          : media && IMAGE.test(name) ? <img src={rawUrl(scope, entry)} alt={name} className="mx-auto max-h-full max-w-full object-contain p-2" />
          : media ? <iframe title={name} src={rawUrl(scope, entry)} className="h-full w-full" />
          : !preview ? <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          : preview.secret ? (
            <div className="space-y-3 p-4 text-sm">
              <p><FileLock className="mb-2 size-5 text-rose-500" />A credential file: it may hold passwords or keys, so its contents stay hidden until you ask. Viewing is logged (the path only).</p>
              {preview.error && <p className="text-destructive">{preview.error}</p>}
              <Button size="sm" variant="outline" disabled={preview.revealing} onClick={reveal}>
                {preview.revealing ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />} Show contents
              </Button>
            </div>
          )
          : preview.error ? <p className="p-4 text-sm text-destructive">{preview.error}</p>
          : editing ? (
            <MonacoViewer key={editorKey} name={name} text={preview.text ?? ""} editable onSave={save}
              onDirty={(d) => setChanges({ key: editorKey, dirty: d })} onReady={(c) => { controls.current = c; }} />
          ) : <MonacoViewer name={preview.mode === "hex" ? `${name}.hexdump` : name} text={preview.text ?? ""} />}
      </div>
      <p className="truncate border-t px-3 py-1 text-xs text-muted-foreground" title={path}>
        {formatBytes(shown.size)} ({shown.size.toLocaleString()} bytes) · modified {when(shown.modified)}
      </p>
    </div>
  );
}
