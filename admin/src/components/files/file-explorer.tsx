"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown, ArrowUp, ChevronDown, ChevronRight, Download, File as FileIcon, FileLock, Folder, FolderOpen, FolderPlus, FolderUp,
  Copy, Eye, FileArchive, Link2, Loader2, Lock, MoveRight, Pencil, RefreshCw, RotateCcw, Save, Search, Trash2, Upload,
} from "lucide-react";
import { toast } from "sonner";
import { useSubject } from "subjecto/react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { BASE_PATH } from "@/lib/config";
import { cn } from "@/lib/utils";
import { startUploads, uploadedInto } from "@/store/uploads";
import { confirmDialog } from "@/lib/ask";
import type { EditorControls } from "./monaco-viewer";
import { filesOfDrop } from "./upload-client";
import { formatBytes, UploadList } from "./upload-list";

const MonacoViewer = dynamic(() => import("./monaco-viewer"), { ssr: false, loading: () => <p className="p-3 text-xs text-muted-foreground">Loading the viewer…</p> });

type Entry = { name: string; path: string; type: "dir" | "file" | "symlink" | "other"; size: number; modified: string; secret: boolean };
type Listing = { path: string; root: string; parent: string | null; entries: Entry[]; noPermission?: boolean };
/**
 * a page of a file's preview, as the API sends it (lib/files/preview); the first page also says whether the file can be
 * edited (then it is the whole file, with the hash a save must still find on disk: lib/files/edit) or why not
 */
type Page = { mode: "text" | "hex"; text: string; size: number; offset: number; next: number; editable?: boolean; readOnly?: string; hash?: string; mtime?: number };
/** what the preview holds: the pages so far (`next` = bytes shown), for a credential file only once revealed */
type Preview = {
  path: string; text?: string; mode?: "text" | "hex"; size?: number; next?: number; reveal?: boolean; more?: boolean; moreError?: string; error?: string; secret?: boolean; revealing?: boolean;
  editable?: boolean; readOnly?: string; hash?: string; mtime?: number;
  /** which read this is (an editor opens afresh with each) */
  load?: number;
};
/** "Load all" asks first when more than this is left: it all goes into the browser */
const LOAD_ALL_ASK = 100 * 1024 * 1024;
/** (`scope`: "&project=<slug>" from a project's Files tab, else "") */
const readUrl = (scope: string, p: string, offset: number, mode?: string, reveal?: boolean) =>
  `${API}?op=read&path=${encodeURIComponent(p)}&offset=${offset}${mode ? `&mode=${mode}` : ""}${reveal ? "&reveal=1" : ""}${scope}`;
type TrashItem = { id: string; name: string; originalPath: string; deletedAt: string; bytes: number; type: string };
type DeletePlan = { path: string; type: string; bytes: number; files: number; truncated: boolean; running: { slug: string; pid: number }[] };
type SortKey = "name" | "size" | "modified" | "type";

const API = `${BASE_PATH}/api/files`;
// (no SVG: it would run on the admin's origin; it previews as text)
const IMAGE = /\.(png|jpe?g|gif|webp|avif|ico)$/i, PDF = /\.pdf$/i;
const within = (p: string, root: string) => root === "/" || p === root || p.startsWith(`${root}/`);
/** kernel pseudo-files (/proc, /sys): listed, never read */
const pseudo = (p: string) => within(p, "/proc") || within(p, "/sys");

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  return body;
}
const postTo = <T,>(body: object) => api<T>(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const extOf = (e: Entry) => (e.type === "dir" ? "folder" : e.name.includes(".") ? e.name.split(".").pop()!.toLowerCase() : "file");

/** one folder in the tree, its subfolders loaded when opened */
function TreeNode({ path, name, depth, current, scope, onOpen }: { path: string; name: string; depth: number; current: string; scope: string; onOpen: (p: string) => void }) {
  const [open, setOpen] = useState(current === path || current.startsWith(`${path}/`));
  const [children, setChildren] = useState<Entry[] | null>(null);
  useEffect(() => {
    if (!open || children) return;
    api<Listing>(`${API}?op=list&path=${encodeURIComponent(path)}${scope}`).then((l) => setChildren(l.entries.filter((e) => e.type === "dir")), () => setChildren([]));
  }, [open, children, path, scope]);
  useEffect(() => {
    if (current.startsWith(`${path}/`)) setOpen(true); // eslint-disable-line react-hooks/set-state-in-effect
  }, [current, path]);
  return (
    <li>
      <div className={cn("flex items-center gap-1 rounded px-1 py-0.5 text-sm hover:bg-muted", current === path && "bg-muted font-medium")} style={{ paddingLeft: depth * 12 + 4 }}>
        <button type="button" aria-label={open ? "Close" : "Open"} onClick={() => setOpen(!open)} className="text-muted-foreground">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <button type="button" onClick={() => onOpen(path)} className="flex min-w-0 items-center gap-1.5 truncate text-left">
          {open ? <FolderOpen className="size-4 shrink-0 text-amber-500" /> : <Folder className="size-4 shrink-0 text-amber-500" />}
          <span className="truncate">{name}</span>
        </button>
      </div>
      {open && children && children.length > 0 && (
        <ul>{children.map((c) => <TreeNode key={c.path} path={c.path} name={c.name} depth={depth + 1} current={current} scope={scope} onOpen={onOpen} />)}</ul>
      )}
    </li>
  );
}

/**
 * The admin's file explorer (T243): the roots' folders as a tree, a folder's files (sort, search, breadcrumbs), a preview
 * (any file, any size, a page at a time: text in a read-only Monaco, binary as hex, images, PDFs; a credential file's
 * contents on request), download, uploads of any size (chunked,
 * resumable, by picking or dropping files and folders), new folder, rename, move, and delete to a trash that restores.
 * A text file the server lets change opens in an editor instead: Save (Ctrl/Cmd+S), refused if it changed on disk
 * meanwhile; unsaved changes are asked about before another file, folder or page replaces them.
 * `project`: a project's Files tab, the explorer rooted at that project's folder (the server holds every request of
 * this view to it, `&project=` / `project`).
 */
export function FileExplorer({ project }: { project?: string } = {}) {
  const scope = project ? `&project=${encodeURIComponent(project)}` : "";
  const [roots, setRoots] = useState<string[]>([]);
  const [cwd, setCwd] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "name", desc: false });
  const [selected, setSelected] = useState<Entry | null>(null);
  const [writeRoots, setWriteRoots] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<
    | { kind: "mkdir" } | { kind: "rename"; entry: Entry } | { kind: "move"; entry: Entry } | { kind: "delete"; entry: Entry; plan?: DeletePlan; error?: string; force: boolean }
    | { kind: "secret"; entry: Entry } | { kind: "trash"; items?: TrashItem[]; error?: string } | null
  >(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [trashCount, setTrashCount] = useState(0);
  const filePick = useRef<HTMLInputElement>(null), folderPick = useRef<HTMLInputElement>(null);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    try {
      const l = await api<Listing>(`${API}?op=list&path=${encodeURIComponent(p)}${scope}`);
      setListing(l);
      setCwd(l.path);
      setError(null);
      setSelected((s) => (s && l.entries.some((e) => e.path === s.path) ? s : null));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [scope]);
  const refreshTrash = useCallback(() => { api<{ items: TrashItem[] }>(`${API}?op=trash${scope}`).then((t) => setTrashCount(t.items.length), () => {}); }, [scope]);
  const post = useCallback(<T,>(body: object) => postTo<T>(project ? { ...body, project } : body), [project]);

  useEffect(() => {
    api<{ roots: string[]; writeRoots: string[] }>(`${API}?op=roots${scope}`).then((r) => {
      setRoots(r.roots);
      setWriteRoots(r.writeRoots);
      // (opens where the work is: the first write root that can be seen, else the first root)
      const start = r.writeRoots.find((w) => r.roots.some((root) => within(w, root))) ?? r.roots[0];
      if (start) void load(start);
    }, (err) => setError((err as Error).message));
    refreshTrash();
  }, [load, refreshTrash, scope]);

  // (a file chosen: its preview; a credential file's contents only after "Show contents", for that file; `reloads`: read
  // it again, after a refused save or dropped changes)
  const [reloads, setReloads] = useState(0);
  const reads = useRef(0), keepPreview = useRef<string | null>(null);
  useEffect(() => {
    // (the file just saved, its entry updated: the preview already holds what is on disk)
    if (selected && keepPreview.current === selected.path) { keepPreview.current = null; return; }
    if (!selected || selected.type !== "file" || pseudo(selected.path) || (!selected.secret && (IMAGE.test(selected.name) || PDF.test(selected.name)))) { setPreview(null); return; }
    if (selected.secret) { setPreview({ path: selected.path, secret: true }); return; }
    let live = true;
    setPreview({ path: selected.path });
    api<Page>(readUrl(scope, selected.path, 0))
      .then((r) => live && setPreview({ path: selected.path, ...r, load: ++reads.current }), (err) => live && setPreview({ path: selected.path, error: (err as Error).message }));
    return () => { live = false; };
  }, [selected, scope, reloads]);

  // The editor (a file the server lets change): unsaved changes, as Monaco reports them for the read it opened with.
  const editing = !!selected && !!preview?.editable && !!preview.hash && preview.path === selected.path;
  const editorKey = preview ? `${preview.path}#${preview.load ?? 0}` : "";
  const [changes, setChanges] = useState<{ key: string; dirty: boolean } | null>(null);
  const dirty = editing && changes?.key === editorKey && changes.dirty;
  const [saving, setSaving] = useState(false);
  const controls = useRef<EditorControls | null>(null);
  /** the file with unsaved changes, for the asks below (they run outside a render) */
  const unsaved = useRef<string | null>(null);
  useEffect(() => { unsaved.current = dirty ? preview?.path ?? null : null; }, [dirty, preview?.path]);
  /** true when what's being left has no unsaved changes, or they are to be dropped (one ask for clicks that come together) */
  const asking = useRef<Promise<boolean> | null>(null);
  const leave = useCallback((): Promise<boolean> => {
    if (!unsaved.current) return Promise.resolve(true);
    asking.current ??= confirmDialog(`${unsaved.current.split("/").pop()} has changes that aren't saved. Discard them?`, { title: "Unsaved changes", confirmLabel: "Discard changes", destructive: true })
      .then((ok) => {
        asking.current = null;
        // (dropped: read again, so a file that stays open shows what is on disk)
        if (ok) { unsaved.current = null; setChanges(null); setReloads((n) => n + 1); }
        return ok;
      });
    return asking.current;
  }, []);
  /** opens a folder / chooses an entry, once unsaved changes are dealt with */
  const go = (p: string) => { void leave().then((ok) => { if (ok) void load(p); }); };
  const choose = (e: Entry) => {
    if (e.path === selected?.path && unsaved.current) return; // (the file being edited: nothing to reload)
    void leave().then((ok) => { if (ok) setSelected(e); });
  };
  const save = async (text: string): Promise<boolean> => {
    const p0 = preview;
    if (!p0?.editable || !p0.hash) return false;
    setSaving(true);
    try {
      const r = await post<{ path: string; size: number; mtime: number; hash: string }>({ op: "write", path: p0.path, content: text, hash: p0.hash });
      setPreview((p) => (p?.path === p0.path && p.load === p0.load ? { ...p, text, size: r.size, next: r.size, hash: r.hash, mtime: r.mtime } : p));
      if (selected?.path === p0.path) {
        keepPreview.current = p0.path;
        setSelected({ ...selected, size: r.size, modified: new Date(r.mtime).toISOString() });
      }
      toast.success(`Saved ${p0.path.split("/").pop()}`);
      void load(cwd);
      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 409) {
        const reload = await confirmDialog(
          `${p0.path.split("/").pop()} changed on disk since it was opened, so it wasn't saved. Reload it from disk? The changes made here are then lost; cancel keeps them, to copy them first.`,
          { title: "Changed on disk", confirmLabel: "Reload from disk", destructive: true },
        );
        if (reload) { unsaved.current = null; setReloads((n) => n + 1); void load(cwd); }
      } else toast.error(`Not saved: ${(err as Error).message}`);
      return false;
    } finally {
      setSaving(false);
    }
  };
  // (Ctrl/Cmd+S saves with the focus anywhere on the page, not only in the editor, which handles it itself)
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      controls.current?.save();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);
  // (leaving the page with unsaved changes: the browser asks on a reload or a close, the app's dialog on a link)
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement) || !unsaved.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (a.target === "_blank" || a.hasAttribute("download")) return;
      e.preventDefault();
      e.stopPropagation();
      void leave().then((ok) => { if (ok) a.click(); });
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("click", onClick, true);
    return () => { window.removeEventListener("beforeunload", onUnload); window.removeEventListener("click", onClick, true); };
  }, [dirty, leave]);

  const entries = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = (listing?.entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q));
    const v = (e: Entry) => (sort.key === "name" ? e.name.toLowerCase() : sort.key === "size" ? e.size : sort.key === "modified" ? e.modified : extOf(e));
    return list.sort((a, b) => {
      if (sort.key === "name" && (a.type === "dir") !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;
      const x = v(a), y = v(b), c = x < y ? -1 : x > y ? 1 : 0;
      return sort.desc ? -c : c;
    });
  }, [listing, filter, sort]);

  const crumbs = useMemo(() => {
    if (!listing) return [];
    const rel = listing.path.slice(listing.root.length).split("/").filter(Boolean);
    return [{ name: listing.root, path: listing.root }, ...rel.map((seg, i) => ({ name: seg, path: `${listing.root}/${rel.slice(0, i + 1).join("/")}` }))];
  }, [listing]);

  // (uploads run on in store/uploads.ts when you leave the page; a finished batch reloads this folder if it's the one showing)
  const [done] = useSubject(uploadedInto);
  const cwdRef = useRef(cwd);
  useEffect(() => { cwdRef.current = cwd; }, [cwd]);
  useEffect(() => {
    if (done && done.dir === cwdRef.current) void load(done.dir);
  }, [done, load]);

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    try {
      await fn();
      setDialog(null);
      after?.();
      void load(cwd);
      refreshTrash();
    } catch (err) {
      setDialog((d) => (d ? { ...d, error: (err as Error).message } as typeof d : d));
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const openDelete = async (entry: Entry) => {
    if (!(await leave())) return;
    setDialog({ kind: "delete", entry, force: false });
    api<DeletePlan>(`${API}?op=plan-delete&path=${encodeURIComponent(entry.path)}${scope}`).then(
      (plan) => setDialog((d) => (d?.kind === "delete" && d.entry.path === entry.path ? { ...d, plan } : d)),
      (err) => setDialog((d) => (d?.kind === "delete" ? { ...d, error: (err as Error).message } : d)),
    );
  };
  const openRename = async (entry: Entry) => {
    if (!(await leave())) return;
    setDraft(entry.name);
    setDialog({ kind: "rename", entry });
  };
  const openMove = async (entry: Entry) => {
    if (!(await leave())) return;
    setDraft(cwd);
    setDialog({ kind: "move", entry });
  };
  const openTrash = () => {
    setDialog({ kind: "trash" });
    api<{ items: TrashItem[] }>(`${API}?op=trash${scope}`).then((t) => setDialog((d) => (d?.kind === "trash" ? { ...d, items: t.items } : d)), () => {});
  };
  const download = (e: Entry, confirmed = false) => {
    if (e.secret && !confirmed) { setDialog({ kind: "secret", entry: e }); return; }
    const a = document.createElement("a");
    a.href = `${API}/raw?path=${encodeURIComponent(e.path)}&download=1${e.secret ? "&confirm=1" : ""}${scope}`;
    a.click();
  };
  /** a folder as a .tar.gz (credential files and node_modules / build dirs left out: api/files/archive) */
  const downloadFolder = (p: string) => {
    const a = document.createElement("a");
    a.href = `${API}/archive?path=${encodeURIComponent(p)}${scope}`;
    a.click();
  };
  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`), () => toast.error("The browser blocked the clipboard"));
  // The right-clicked row; null = the empty space, i.e. the folder shown.
  const [menuEntry, setMenuEntry] = useState<Entry | null>(null);
  const menuTarget: Entry | null = menuEntry ?? (cwd ? { name: cwd.split("/").pop() || "/", path: cwd, type: "dir", size: 0, modified: "", secret: false } : null);
  const th = (key: SortKey, label: string, cls = "") => (
    <th scope="col" className={cn("px-2 py-1.5 font-medium", cls)} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" && key !== "type" }))}>
        {label}{sort.key === key && (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
      </button>
    </th>
  );
  const reveal = (e: Entry) => {
    setPreview({ path: e.path, secret: true, revealing: true });
    api<Page>(readUrl(scope, e.path, 0, undefined, true))
      .then((r) => setPreview((p) => (p?.path === e.path ? { path: e.path, ...r, reveal: true } : p)), (err) => setPreview((p) => (p?.path === e.path ? { path: e.path, secret: true, error: (err as Error).message } : p)));
  };
  /** the preview's next page, or (`all`) every page left until the end or "Stop"; appended, the viewer keeps its place */
  const stopLoading = useRef(false), previewPath = useRef<string | null>(null);
  useEffect(() => { previewPath.current = preview?.path ?? null; }, [preview?.path]);
  const loadMore = async (all: boolean) => {
    const p0 = preview;
    if (!p0 || p0.next == null || p0.size == null || p0.more) return;
    const left = p0.size - p0.next;
    if (all && left > LOAD_ALL_ASK && !(await confirmDialog(`Load the remaining ${formatBytes(left)} into the browser? A file this big can make this tab slow, or crash it.`, { confirmLabel: "Load it all" }))) return;
    stopLoading.current = false;
    setPreview((p) => (p?.path === p0.path ? { ...p, more: true, moreError: undefined } : p));
    let next = p0.next, size = p0.size;
    try {
      do {
        const r = await api<Page>(readUrl(scope, p0.path, next, p0.mode, p0.reveal));
        if (r.next <= next) break; // (nothing new: the file shrank)
        next = r.next;
        size = r.size;
        setPreview((p) => (p?.path === p0.path ? { ...p, text: (p.text ?? "") + (p.mode === "hex" ? "\n" : "") + r.text, next: r.next, size: r.size } : p));
      } while (all && next < size && !stopLoading.current && previewPath.current === p0.path);
    } catch (err) {
      setPreview((p) => (p?.path === p0.path ? { ...p, moreError: (err as Error).message } : p));
    } finally {
      setPreview((p) => (p?.path === p0.path ? { ...p, more: false } : p));
    }
  };
  /** changes are allowed here (the server checks again) */
  const writable = writeRoots.some((w) => within(cwd, w));
  const changeable = (p: string) => writeRoots.some((w) => within(p, w) && p !== w);
  const readOnlyWhy = `Read-only here: changes only under ${writeRoots.join(", ")}`;
  // (the file's size and time: as last read when the editor read it, which can be newer than the listing)
  const shown = editing && preview.size != null && preview.mtime != null
    ? { size: preview.size, modified: new Date(preview.mtime).toISOString() }
    : { size: selected?.size ?? 0, modified: selected?.modified ?? "" };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Folder" className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-3.5 text-muted-foreground" />}
              <button type="button" onClick={() => go(c.path)} className={cn("rounded px-1 hover:bg-muted", i === crumbs.length - 1 && "font-semibold")}>{c.name}</button>
            </span>
          ))}
        </nav>
        <div className="relative">
          <Search className="absolute top-2 left-2 size-4 text-muted-foreground" />
          <Input aria-label="Search this folder" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search this folder" className="h-8 w-48 pl-7" />
        </div>
        {!writable && cwd && <span className="flex items-center gap-1 text-xs text-muted-foreground" title={readOnlyWhy}><Lock className="size-3.5" /> Read-only</span>}
        <Button size="sm" variant="outline" disabled={!writable} title={writable ? undefined : readOnlyWhy} onClick={() => { setDraft(""); setDialog({ kind: "mkdir" }); }}><FolderPlus className="size-4" /> New folder</Button>
        <Button size="sm" variant="outline" disabled={!writable} title={writable ? undefined : readOnlyWhy} onClick={() => filePick.current?.click()}><Upload className="size-4" /> Upload files</Button>
        <Button size="sm" variant="outline" disabled={!writable} title={writable ? undefined : readOnlyWhy} onClick={() => folderPick.current?.click()}><FolderUp className="size-4" /> Upload a folder</Button>
        <Button size="sm" variant="outline" onClick={openTrash}><Trash2 className="size-4" /> Trash{trashCount ? ` (${trashCount})` : ""}</Button>
        <Button size="sm" variant="ghost" aria-label="Refresh" onClick={() => load(cwd)}><RefreshCw className={cn("size-4", loading && "animate-spin")} /></Button>
        <input ref={filePick} type="file" multiple hidden onChange={(e) => { const fs = [...(e.target.files ?? [])].map((file) => ({ file, rel: file.name })); e.target.value = ""; void startUploads(fs, cwd, project); }} />
        <input ref={folderPick} type="file" multiple hidden {...{ webkitdirectory: "" }} onChange={(e) => { const fs = [...(e.target.files ?? [])].map((file) => ({ file, rel: file.webkitRelativePath || file.name })); e.target.value = ""; void startUploads(fs, cwd, project); }} />
      </div>
      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[240px_1fr_380px]">
        <aside className="min-h-0 overflow-auto rounded-lg border p-1" aria-label="Folders">
          <ul>{roots.map((r) => <TreeNode key={r} path={r} name={r} depth={0} current={cwd} scope={scope} onOpen={go} />)}</ul>
        </aside>

        <section
          className={cn("relative min-h-0 overflow-auto rounded-lg border", dragging && "ring-2 ring-primary")}
          onDragOver={(e) => { if (writable && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
          onDrop={async (e) => { e.preventDefault(); setDragging(false); void startUploads(await filesOfDrop(e.dataTransfer.items), cwd, project); }}
          aria-label="Files"
        >
          {dragging && <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-primary/10 text-sm font-medium">Drop to upload into {cwd}</div>}
          {/* Right-click a file / folder (or the empty space, for this folder): download, copy path, … */}
          <ContextMenu>
          <ContextMenuTrigger onContextMenuCapture={() => setMenuEntry(null)}>
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background text-left text-xs text-muted-foreground">
              <tr>{th("name", "Name", "w-full")}{th("size", "Size", "text-right whitespace-nowrap")}{th("modified", "Modified", "whitespace-nowrap")}{th("type", "Type")}<th className="w-24" /></tr>
            </thead>
            <tbody>
              {listing?.parent && (
                <tr className="cursor-pointer hover:bg-muted/60" onDoubleClick={() => go(listing.parent!)}>
                  <td className="px-2 py-1" colSpan={5}><button type="button" onClick={() => go(listing.parent!)} className="flex items-center gap-1.5 text-muted-foreground"><Folder className="size-4" /> ..</button></td>
                </tr>
              )}
              {entries.map((e) => (
                <tr key={e.path} aria-selected={selected?.path === e.path} onClick={() => choose(e)} onContextMenu={() => setMenuEntry(e)} onDoubleClick={() => (e.type === "dir" ? go(e.path) : choose(e))}
                  className={cn("group cursor-default border-t hover:bg-muted/60", selected?.path === e.path && "bg-muted")}>
                  <td className="max-w-0 px-2 py-1">
                    <span className="flex items-center gap-1.5 truncate">
                      {e.type === "dir" ? <Folder className="size-4 shrink-0 text-amber-500" /> : e.secret ? <FileLock className="size-4 shrink-0 text-rose-500" /> : e.type === "symlink" ? <Link2 className="size-4 shrink-0 text-muted-foreground" /> : <FileIcon className="size-4 shrink-0 text-muted-foreground" />}
                      {e.type === "dir" ? <button type="button" className="truncate hover:underline" onClick={() => go(e.path)}>{e.name}</button> : <span className="truncate">{e.name}</span>}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-muted-foreground">{e.type === "file" ? formatBytes(e.size) : ""}</td>
                  <td className="px-2 py-1 whitespace-nowrap text-muted-foreground">{when(e.modified)}</td>
                  <td className="px-2 py-1 text-muted-foreground">{e.secret ? "credential" : extOf(e)}</td>
                  <td className="px-1 py-1">
                    <span className="flex justify-end gap-0.5 opacity-60 group-hover:opacity-100">
                      {e.type === "file" && !pseudo(e.path) && <button type="button" title="Download" aria-label={`Download ${e.name}`} onClick={() => download(e)} className="rounded p-1 hover:bg-background"><Download className="size-3.5" /></button>}
                      {changeable(e.path) && (
                        <>
                          <button type="button" title="Rename" aria-label={`Rename ${e.name}`} onClick={() => void openRename(e)} className="rounded p-1 hover:bg-background"><Pencil className="size-3.5" /></button>
                          <button type="button" title="Move" aria-label={`Move ${e.name}`} onClick={() => void openMove(e)} className="rounded p-1 hover:bg-background"><MoveRight className="size-3.5" /></button>
                          <button type="button" title="Delete" aria-label={`Delete ${e.name}`} onClick={() => void openDelete(e)} className="rounded p-1 text-destructive hover:bg-background"><Trash2 className="size-3.5" /></button>
                        </>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
              {listing && entries.length === 0 && (
                <tr><td colSpan={5} className="px-2 py-8 text-center text-muted-foreground">
                  {listing.noPermission ? <><Lock className="mx-auto mb-1 size-5" />No permission: the genie user can&apos;t read this folder.</>
                    : filter ? "Nothing here matches." : writable ? "An empty folder: drop files here to upload them." : "An empty folder."}
                </td></tr>
              )}
              {!listing && !error && <tr><td colSpan={5} className="px-2 py-8 text-center text-muted-foreground"><Loader2 className="mx-auto size-5 animate-spin" /></td></tr>}
            </tbody>
          </table>
          </ContextMenuTrigger>
          {menuTarget && (
            <ContextMenuContent className="w-56">
              <ContextMenuLabel className="truncate font-mono" title={menuTarget.path}>
                {menuEntry ? menuTarget.name : `${menuTarget.path} (this folder)`}
              </ContextMenuLabel>
              <ContextMenuSeparator />
              {menuEntry && (menuTarget.type === "dir" ? (
                <ContextMenuItem onClick={() => go(menuTarget.path)}><FolderOpen /> Open</ContextMenuItem>
              ) : (
                <ContextMenuItem onClick={() => choose(menuTarget)}><Eye /> Preview</ContextMenuItem>
              ))}
              {!pseudo(menuTarget.path) && (menuTarget.type === "dir" ? (
                <ContextMenuItem onClick={() => downloadFolder(menuTarget.path)} title="Credential files, node_modules and build folders are left out">
                  <FileArchive /> Download as .tar.gz
                </ContextMenuItem>
              ) : menuTarget.type === "file" ? (
                <ContextMenuItem onClick={() => download(menuTarget)}><Download /> Download</ContextMenuItem>
              ) : null)}
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => copy(menuTarget.path, "Path")}><Copy /> Copy path</ContextMenuItem>
              <ContextMenuItem onClick={() => copy(menuTarget.name, "Name")}><Copy /> Copy name</ContextMenuItem>
              {menuEntry && changeable(menuTarget.path) && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => void openRename(menuTarget)}><Pencil /> Rename</ContextMenuItem>
                  <ContextMenuItem onClick={() => void openMove(menuTarget)}><MoveRight /> Move</ContextMenuItem>
                  <ContextMenuItem variant="destructive" onClick={() => void openDelete(menuTarget)}><Trash2 /> Delete</ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          )}
          </ContextMenu>
        </section>

        <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border" aria-label="Preview">
          {!selected ? (
            <p className="p-4 text-sm text-muted-foreground">Select a file to preview it.</p>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={selected.path}>
                  {selected.name}{dirty && <span className="ml-1.5 text-amber-500" title="Unsaved changes" aria-label="Unsaved changes">●</span>}
                </span>
                {editing ? (
                  <Button size="sm" disabled={!dirty || saving} title="Save (Ctrl+S)" onClick={() => controls.current?.save()}>
                    {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save
                  </Button>
                ) : preview?.path === selected.path && preview.readOnly && preview.mode === "text" && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground" title={`Read-only: ${preview.readOnly}`}><Lock className="size-3.5" /> Read-only</span>
                )}
                {selected.type === "file" && !pseudo(selected.path) && <Button size="sm" variant="outline" onClick={() => download(selected)}><Download className="size-4" /> Download</Button>}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {selected.type === "dir" ? <p className="p-4 text-sm text-muted-foreground">A folder. Double-click it to open.</p>
                  : selected.type !== "file" ? <p className="p-4 text-sm text-muted-foreground">{selected.type === "symlink" ? "A symbolic link." : "Not a regular file (a device, socket or pipe): nothing to preview."}</p>
                  : pseudo(selected.path) ? <p className="p-4 text-sm text-muted-foreground">A kernel file (/proc, /sys): listed here, not read.</p>
                  : selected.secret && preview?.path === selected.path && preview.secret ? (
                    <div className="space-y-3 p-4 text-sm">
                      <p><FileLock className="mb-2 size-5 text-rose-500" />A credential file: it may hold passwords or keys, so its contents stay hidden until you ask. Viewing is logged (the path only).</p>
                      {preview.error && <p className="text-destructive">{preview.error}</p>}
                      <Button size="sm" variant="outline" disabled={preview.revealing} onClick={() => reveal(selected)}>
                        {preview.revealing ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />} Show contents
                      </Button>
                    </div>
                  )
                  // eslint-disable-next-line @next/next/no-img-element -- (the admin's own API, behind its session: not for the image optimizer)
                  : !selected.secret && IMAGE.test(selected.name) ? <img src={`${API}/raw?path=${encodeURIComponent(selected.path)}${scope}`} alt={selected.name} className="mx-auto max-h-full max-w-full object-contain p-2" />
                  : !selected.secret && PDF.test(selected.name) ? <iframe title={selected.name} src={`${API}/raw?path=${encodeURIComponent(selected.path)}${scope}`} className="h-full w-full" />
                  : !preview || preview.path !== selected.path ? <p className="p-4 text-sm text-muted-foreground">Loading…</p>
                  : preview.error ? <p className="p-4 text-sm text-destructive">{preview.error}</p>
                  : (
                    <div className="flex h-full flex-col">
                      {(preview.mode === "hex" || (preview.next ?? 0) < (preview.size ?? 0)) && (
                        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
                          <span className="mr-auto">
                            {preview.mode === "hex" && "A binary file, as hex. "}
                            {(preview.next ?? 0) < (preview.size ?? 0) ? `The first ${formatBytes(preview.next ?? 0)} of ${formatBytes(preview.size ?? 0)}.` : `All ${formatBytes(preview.size ?? 0)}.`}
                          </span>
                          {preview.moreError && <span className="text-destructive">{preview.moreError}</span>}
                          {preview.more ? (
                            <>
                              <Loader2 className="size-3.5 animate-spin" />
                              <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground" onClick={() => { stopLoading.current = true; }}>Stop</button>
                            </>
                          ) : (preview.next ?? 0) < (preview.size ?? 0) && (
                            <>
                              <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground" onClick={() => void loadMore(false)}>Load more</button>
                              <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground" onClick={() => void loadMore(true)}>Load all</button>
                            </>
                          )}
                        </div>
                      )}
                      <div className="min-h-[300px] flex-1">
                        {editing ? (
                          <MonacoViewer key={editorKey} name={selected.name} text={preview.text ?? ""} editable onSave={save}
                            onDirty={(d) => setChanges({ key: editorKey, dirty: d })} onReady={(c) => { controls.current = c; }} />
                        ) : <MonacoViewer name={preview.mode === "hex" ? `${selected.name}.hexdump` : selected.name} text={preview.text ?? ""} />}
                      </div>
                    </div>
                  )}
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-t px-3 py-2 text-xs text-muted-foreground">
                <dt>Path</dt><dd className="truncate font-mono" title={selected.path}>{selected.path}</dd>
                <dt>Size</dt><dd>{selected.type === "file" ? `${formatBytes(shown.size)} (${shown.size.toLocaleString()} bytes)` : "—"}</dd>
                <dt>Modified</dt><dd>{when(shown.modified)}</dd>
              </dl>
            </>
          )}
        </aside>
      </div>

      <UploadList />

      <Dialog open={!!dialog} onOpenChange={(o) => { if (!o && !busy) setDialog(null); }}>
        <DialogContent className="sm:max-w-lg">
          {dialog?.kind === "mkdir" && (
            <form onSubmit={(e) => { e.preventDefault(); void act(() => post({ op: "mkdir", dir: cwd, name: draft })); }}>
              <DialogHeader><DialogTitle>New folder</DialogTitle><DialogDescription>In {cwd}</DialogDescription></DialogHeader>
              <Input autoFocus aria-label="Folder name" value={draft} onChange={(e) => setDraft(e.target.value)} className="my-3" />
              <DialogFooter><Button type="submit" disabled={!draft.trim() || busy}>Create</Button></DialogFooter>
            </form>
          )}
          {dialog?.kind === "rename" && (
            <form onSubmit={(e) => { e.preventDefault(); void act(() => post({ op: "rename", path: dialog.entry.path, name: draft }), () => setSelected(null)); }}>
              <DialogHeader><DialogTitle>Rename</DialogTitle><DialogDescription>{dialog.entry.path}</DialogDescription></DialogHeader>
              <Input autoFocus aria-label="New name" value={draft} onChange={(e) => setDraft(e.target.value)} className="my-3" />
              <DialogFooter><Button type="submit" disabled={!draft.trim() || draft === dialog.entry.name || busy}>Rename</Button></DialogFooter>
            </form>
          )}
          {dialog?.kind === "move" && (
            <form onSubmit={(e) => { e.preventDefault(); void act(() => post({ op: "move", path: dialog.entry.path, to: draft }), () => setSelected(null)); }}>
              <DialogHeader><DialogTitle>Move {dialog.entry.name}</DialogTitle><DialogDescription>To the folder (a full path inside {roots.join(" or ")}):</DialogDescription></DialogHeader>
              <Input autoFocus aria-label="Destination folder" value={draft} onChange={(e) => setDraft(e.target.value)} className="my-3 font-mono" />
              <DialogFooter><Button type="submit" disabled={!draft.trim() || busy}>Move</Button></DialogFooter>
            </form>
          )}
          {dialog?.kind === "delete" && (
            <>
              <DialogHeader>
                <DialogTitle>Delete {dialog.entry.type === "dir" ? "this folder" : "this file"}?</DialogTitle>
                <DialogDescription className="font-mono break-all">{dialog.entry.path}</DialogDescription>
              </DialogHeader>
              {dialog.error ? <p className="text-sm text-destructive">{dialog.error}</p>
                : !dialog.plan ? <p className="text-sm text-muted-foreground"><Loader2 className="mr-1 inline size-4 animate-spin" />Measuring…</p>
                : (
                  <div className="space-y-2 text-sm">
                    <p>{dialog.plan.type === "dir" ? `${dialog.plan.truncated ? "At least " : ""}${dialog.plan.files.toLocaleString()} file${dialog.plan.files === 1 ? "" : "s"}, ${formatBytes(dialog.plan.bytes)}.` : formatBytes(dialog.plan.bytes)} It goes to the trash, from where it can be restored.</p>
                    {dialog.plan.running.length > 0 && (
                      <label className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2">
                        <input type="checkbox" checked={dialog.force} onChange={(e) => setDialog({ ...dialog, force: e.target.checked })} className="mt-1" />
                        <span>Running inside it: {dialog.plan.running.map((r) => r.slug).join(", ")}. Delete anyway?</span>
                      </label>
                    )}
                  </div>
                )}
              <DialogFooter>
                <Button variant="destructive" disabled={busy || !dialog.plan || !!dialog.error || (dialog.plan.running.length > 0 && !dialog.force)}
                  onClick={() => act(() => post({ op: "delete", path: dialog.entry.path, force: dialog.force }), () => setSelected(null))}>
                  <Trash2 className="size-4" /> Move to the trash
                </Button>
              </DialogFooter>
            </>
          )}
          {dialog?.kind === "secret" && (
            <>
              <DialogHeader><DialogTitle>Download a credential file?</DialogTitle><DialogDescription className="font-mono break-all">{dialog.entry.path}</DialogDescription></DialogHeader>
              <p className="text-sm">It may hold passwords or keys. It downloads to this computer; the download is logged.</p>
              <DialogFooter><Button onClick={() => { download(dialog.entry, true); setDialog(null); }}><Download className="size-4" /> Download</Button></DialogFooter>
            </>
          )}
          {dialog?.kind === "trash" && (
            <>
              <DialogHeader><DialogTitle>Trash</DialogTitle><DialogDescription>Deleted files and folders{project ? " from this project" : ""}, newest first. Restore puts one back where it was.</DialogDescription></DialogHeader>
              {dialog.error && <p className="text-sm text-destructive">{dialog.error}</p>}
              {!dialog.items ? <p className="text-sm text-muted-foreground"><Loader2 className="mr-1 inline size-4 animate-spin" />Loading…</p>
                : dialog.items.length === 0 ? <p className="text-sm text-muted-foreground">The trash is empty.</p>
                : (
                  <ul className="max-h-80 space-y-1 overflow-auto text-sm">
                    {dialog.items.map((i) => (
                      <li key={i.id} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-muted">
                        {i.type === "dir" ? <Folder className="size-4 shrink-0 text-amber-500" /> : <FileIcon className="size-4 shrink-0 text-muted-foreground" />}
                        <span className="min-w-0 flex-1"><span className="block truncate font-mono text-xs" title={i.originalPath}>{i.originalPath}</span><span className="text-xs text-muted-foreground">{formatBytes(i.bytes)} · deleted {when(i.deletedAt)}</span></span>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => post({ op: "restore", id: i.id }), openTrash)}><RotateCcw className="size-3.5" /> Restore</Button>
                      </li>
                    ))}
                  </ul>
                )}
              {/* (the whole trash empties from Files, where all of it shows) */}
              {!project && <DialogFooter>
                <Button variant="destructive" disabled={busy || !dialog.items?.length}
                  onClick={async () => { if (await confirmDialog(`Delete ${dialog.items?.length} item(s) in the trash for good (${formatBytes(dialog.items?.reduce((n, i) => n + i.bytes, 0) ?? 0)})? This can't be undone.`, { confirmLabel: "Empty the trash", destructive: true })) void act(() => post({ op: "empty-trash" })); }}>
                  Empty the trash
                </Button>
              </DialogFooter>}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
