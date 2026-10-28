"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow, ArrowDown, ArrowUp, ChevronDown, ChevronRight, Download, File as FileIcon, FileLock, Folder, FolderOpen, FolderPlus, FolderUp,
  Copy, FileArchive, Link2, Loader2, Lock, MoveRight, RefreshCw, RotateCcw, Search, TextCursorInput, Trash2, Upload,
} from "lucide-react";
import { toast } from "sonner";
import { useSubject } from "subjecto/react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useIsMobile } from "@/lib/use-is-mobile";
import { cn } from "@/lib/utils";
import { Z_FILE_DIALOGS, Z_FILE_WINDOWS } from "@/lib/z-layers";
import { startUploads, uploadedInto } from "@/store/uploads";
import { confirmDialog } from "@/lib/ask";
import { API, api, downloadFile, type Entry, postTo, pseudo, viewable, when, within } from "./files-api";
import { FileWindow } from "./file-window";
import { filesOfDrop } from "./upload-client";
import { formatBytes, UploadList } from "./upload-list";

type Listing = { path: string; root: string; parent: string | null; entries: Entry[]; noPermission?: boolean };
type TrashItem = { id: string; name: string; originalPath: string; deletedAt: string; bytes: number; type: string };
type DeletePlan = { path: string; type: string; bytes: number; files: number; truncated: boolean; running: { slug: string; pid: number }[] };
type SortKey = "name" | "size" | "modified" | "type";
/** an open file window: its file, its place in the cascade, its stacking, and a count that asks it to take the focus */
type Win = { entry: Entry; index: number; z: number; focus: number };

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
 * The admin's file explorer (T243): the roots' folders as a tree, a folder's files (sort, search, breadcrumbs), the
 * selection's details, download, uploads of any size (chunked, resumable, by picking or dropping files and folders), new
 * folder, rename, move, and delete to a trash that restores. A file clicked opens in its own window (file-window.tsx,
 * several at once, and they stay open from folder to folder): any file, any size, a page at a time, images, PDFs, a
 * credential file's contents on request, and a text file the server lets change in an editor (file-viewer.tsx). Unsaved
 * changes are asked about before their window closes, the file is renamed, moved or deleted, or the page is left.
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
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<
    | { kind: "mkdir" } | { kind: "rename"; entry: Entry } | { kind: "move"; entry: Entry } | { kind: "delete"; entry: Entry; plan?: DeletePlan; error?: string; force: boolean }
    | { kind: "trash"; items?: TrashItem[]; error?: string } | null
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
      setSelected((s) => (s && l.entries.find((e) => e.path === s.path)) ?? null);
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

  // The file windows: opened by a click on a file (again: that window to the front), the frontmost is `active`.
  const isMobile = useIsMobile();
  const [wins, setWins] = useState<Win[]>([]);
  const zTop = useRef(Z_FILE_WINDOWS), opened = useRef(0);
  const active = wins.reduce<Win | null>((top, w) => (!top || w.z > top.z ? w : top), null)?.entry.path;
  const openFile = (e: Entry) => {
    if (!viewable(e)) return;
    setWins((ws) => (ws.some((w) => w.entry.path === e.path)
      ? ws.map((w) => (w.entry.path === e.path ? { ...w, z: ++zTop.current, focus: w.focus + 1 } : w))
      : [...ws, { entry: e, index: opened.current++, z: ++zTop.current, focus: 1 }]));
  };
  const raise = useCallback((p: string) => {
    setWins((ws) => (Math.max(...ws.map((w) => w.z)) === ws.find((w) => w.entry.path === p)?.z ? ws : ws.map((w) => (w.entry.path === p ? { ...w, z: ++zTop.current } : w))));
  }, []);
  /** the files with unsaved changes (a ref too, for the asks below, which run outside a render) */
  const [dirty, setDirty] = useState<string[]>([]);
  const unsaved = useRef<string[]>([]);
  const markDirty = useCallback((p: string, d: boolean) => {
    setDirty((ds) => {
      const next = d === ds.includes(p) ? ds : d ? [...ds, p] : ds.filter((x) => x !== p);
      unsaved.current = next;
      return next;
    });
  }, []);
  /** closes the windows of `paths` (their changes, if any, dropped) */
  const closeWins = useCallback((gone: (p: string) => boolean) => {
    setWins((ws) => ws.filter((w) => !gone(w.entry.path)));
    unsaved.current = unsaved.current.filter((p) => !gone(p));
    setDirty(unsaved.current);
  }, []);
  /**
   * true when the windows of what's being left (`under`: a file or folder about to be renamed, moved or deleted; else
   * all of them, the page) have no unsaved changes, or they are to be dropped: then those windows close (one ask for
   * clicks that come together)
   */
  const asking = useRef<Promise<boolean> | null>(null);
  const leave = useCallback((under?: string): Promise<boolean> => {
    const hit = (p: string) => !under || within(p, under);
    const lost = unsaved.current.filter(hit);
    if (!lost.length) return Promise.resolve(true);
    const names = lost.map((p) => p.split("/").pop());
    asking.current ??= confirmDialog(
      lost.length === 1 ? `${names[0]} has changes that aren't saved. Discard them?` : `${lost.length} files have changes that aren't saved (${names.join(", ")}). Discard them?`,
      { title: "Unsaved changes", confirmLabel: "Discard changes", destructive: true },
    ).then((ok) => {
      asking.current = null;
      if (ok) closeWins((p) => lost.includes(p));
      return ok;
    });
    return asking.current;
  }, [closeWins]);
  /** a window's ×, or Escape in it: asks first when it has unsaved changes */
  const closeWin = (p: string) => { void leave(p).then((ok) => { if (ok) closeWins((x) => x === p); }); };
  /** a window's file saved: the listing (and the details, if it's the selection) show what is on disk now */
  const saved = (p: string, r: { size: number; mtime: number }) => {
    setSelected((s) => (s?.path === p ? { ...s, size: r.size, modified: new Date(r.mtime).toISOString() } : s));
    void load(cwdRef.current);
  };
  /** opens a folder; the file windows stay open */
  const go = (p: string) => { void load(p); };
  /** a row clicked: selected, and a file opened in its window (not when the click was one of the row's buttons) */
  const choose = (e: Entry, target?: EventTarget) => {
    setSelected(e);
    if (!(target as Element | undefined)?.closest?.("button")) openFile(e);
  };
  // (leaving the page with unsaved changes: the browser asks on a reload or a close, the app's dialog on a link)
  const anyDirty = dirty.length > 0;
  useEffect(() => {
    if (!anyDirty) return;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement) || !unsaved.current.length || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (a.target === "_blank" || a.hasAttribute("download")) return;
      e.preventDefault();
      e.stopPropagation();
      void leave().then((ok) => { if (ok) a.click(); });
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("click", onClick, true);
    return () => { window.removeEventListener("beforeunload", onUnload); window.removeEventListener("click", onClick, true); };
  }, [anyDirty, leave]);

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
  // (renamed, moved or deleted: its windows, or those of the files in it, close; changes in them are asked about first)
  const gone = (entry: Entry) => () => { setSelected(null); closeWins((p) => within(p, entry.path)); };
  const openDelete = async (entry: Entry) => {
    if (!(await leave(entry.path))) return;
    setDialog({ kind: "delete", entry, force: false });
    api<DeletePlan>(`${API}?op=plan-delete&path=${encodeURIComponent(entry.path)}${scope}`).then(
      (plan) => setDialog((d) => (d?.kind === "delete" && d.entry.path === entry.path ? { ...d, plan } : d)),
      (err) => setDialog((d) => (d?.kind === "delete" ? { ...d, error: (err as Error).message } : d)),
    );
  };
  const openRename = async (entry: Entry) => {
    if (!(await leave(entry.path))) return;
    setDraft(entry.name);
    setDialog({ kind: "rename", entry });
  };
  const openMove = async (entry: Entry) => {
    if (!(await leave(entry.path))) return;
    setDraft(cwd);
    setDialog({ kind: "move", entry });
  };
  const openTrash = () => {
    setDialog({ kind: "trash" });
    api<{ items: TrashItem[] }>(`${API}?op=trash${scope}`).then((t) => setDialog((d) => (d?.kind === "trash" ? { ...d, items: t.items } : d)), () => {});
  };
  const download = (e: Entry) => void downloadFile(scope, e);
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
  /** changes are allowed here (the server checks again) */
  const writable = writeRoots.some((w) => within(cwd, w));
  const changeable = (p: string) => writeRoots.some((w) => within(p, w) && p !== w);
  const readOnlyWhy = `Read-only here: changes only under ${writeRoots.join(", ")}`;
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

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[240px_1fr_300px]">
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
              <tr>{th("name", "Name", "w-full")}{th("size", "Size", "text-right whitespace-nowrap")}{th("modified", "Modified", "whitespace-nowrap")}{th("type", "Type")}<th className="w-28" /></tr>
            </thead>
            <tbody>
              {listing?.parent && (
                <tr className="cursor-pointer hover:bg-muted/60" onDoubleClick={() => go(listing.parent!)}>
                  <td className="px-2 py-1" colSpan={5}><button type="button" onClick={() => go(listing.parent!)} className="flex items-center gap-1.5 text-muted-foreground"><Folder className="size-4" /> ..</button></td>
                </tr>
              )}
              {entries.map((e) => (
                <tr key={e.path} aria-selected={selected?.path === e.path} onClick={(ev) => choose(e, ev.target)} onContextMenu={() => setMenuEntry(e)} onDoubleClick={(ev) => (e.type === "dir" ? go(e.path) : choose(e, ev.target))}
                  className={cn("group border-t hover:bg-muted/60", viewable(e) ? "cursor-pointer" : "cursor-default", selected?.path === e.path && "bg-muted")}
                  title={viewable(e) ? `Open ${e.name} in a window` : undefined}>
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
                      {viewable(e) && (
                        <>
                          <button type="button" title="Open in a window" aria-label={`Open ${e.name}`} onClick={() => openFile(e)} className="rounded p-1 hover:bg-background"><AppWindow className="size-3.5" /></button>
                          <button type="button" title="Download" aria-label={`Download ${e.name}`} onClick={() => download(e)} className="rounded p-1 hover:bg-background"><Download className="size-3.5" /></button>
                        </>
                      )}
                      {changeable(e.path) && (
                        <>
                          <button type="button" title="Rename" aria-label={`Rename ${e.name}`} onClick={() => void openRename(e)} className="rounded p-1 hover:bg-background"><TextCursorInput className="size-3.5" /></button>
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
            <ContextMenuContent className="w-56" positionerStyle={{ zIndex: Z_FILE_DIALOGS }}>
              <ContextMenuLabel className="truncate font-mono" title={menuTarget.path}>
                {menuEntry ? menuTarget.name : `${menuTarget.path} (this folder)`}
              </ContextMenuLabel>
              <ContextMenuSeparator />
              {menuEntry && (menuTarget.type === "dir" ? (
                <ContextMenuItem onClick={() => go(menuTarget.path)}><FolderOpen /> Open</ContextMenuItem>
              ) : (
                viewable(menuTarget) && <ContextMenuItem onClick={() => { setSelected(menuTarget); openFile(menuTarget); }}><AppWindow /> Open in a window</ContextMenuItem>
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
                  <ContextMenuItem onClick={() => void openRename(menuTarget)}><TextCursorInput /> Rename</ContextMenuItem>
                  <ContextMenuItem onClick={() => void openMove(menuTarget)}><MoveRight /> Move</ContextMenuItem>
                  <ContextMenuItem variant="destructive" onClick={() => void openDelete(menuTarget)}><Trash2 /> Delete</ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          )}
          </ContextMenu>
        </section>

        <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border" aria-label="Details">
          {!selected ? (
            <p className="p-4 text-sm text-muted-foreground">Click a file to open it in its own window, where a text file can be edited. Several can be open at once.</p>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={selected.path}>
                  {selected.name}{dirty.includes(selected.path) && <span className="ml-1.5 text-amber-500" title="Unsaved changes" aria-label="Unsaved changes">●</span>}
                </span>
                {viewable(selected) ? <Button size="sm" onClick={() => openFile(selected)}><AppWindow className="size-4" /> Open</Button>
                  : selected.type === "dir" && <Button size="sm" variant="outline" onClick={() => go(selected.path)}><FolderOpen className="size-4" /> Open</Button>}
                {viewable(selected) && <Button size="sm" variant="outline" aria-label={`Download ${selected.name}`} title="Download" onClick={() => download(selected)}><Download className="size-4" /></Button>}
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-4 text-sm text-muted-foreground">
                {selected.type === "dir" ? "A folder. Double-click it to open."
                  : selected.type !== "file" ? (selected.type === "symlink" ? "A symbolic link." : "Not a regular file (a device, socket or pipe): nothing to preview.")
                  : pseudo(selected.path) ? "A kernel file (/proc, /sys): listed here, not read."
                  : selected.secret ? <><FileLock className="mb-2 size-5 text-rose-500" />A credential file: its window shows the contents only when asked to.</>
                  : wins.some((w) => w.entry.path === selected.path) ? "Open in a window: Open brings it to the front."
                  : "Open shows it in its own window: move it by its title, resize it from an edge or corner."}
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-t px-3 py-2 text-xs text-muted-foreground">
                <dt>Path</dt><dd className="truncate font-mono" title={selected.path}>{selected.path}</dd>
                <dt>Size</dt><dd>{selected.type === "file" ? `${formatBytes(selected.size)} (${selected.size.toLocaleString()} bytes)` : "—"}</dd>
                <dt>Modified</dt><dd>{when(selected.modified)}</dd>
              </dl>
            </>
          )}
        </aside>
      </div>

      {wins.map((w) => (
        <FileWindow key={w.entry.path} entry={w.entry} scope={scope} project={project} index={w.index} z={w.z} active={w.entry.path === active}
          focusTick={w.focus} mobile={isMobile} dirty={dirty.includes(w.entry.path)} onRaise={() => raise(w.entry.path)} onClose={() => closeWin(w.entry.path)}
          onDirty={(d) => markDirty(w.entry.path, d)} onSaved={(r) => saved(w.entry.path, r)} />
      ))}

      <UploadList />

      <Dialog open={!!dialog} onOpenChange={(o) => { if (!o && !busy) setDialog(null); }}>
        <DialogContent className="sm:max-w-lg" style={{ zIndex: Z_FILE_DIALOGS }}>
          {dialog?.kind === "mkdir" && (
            <form onSubmit={(e) => { e.preventDefault(); void act(() => post({ op: "mkdir", dir: cwd, name: draft })); }}>
              <DialogHeader><DialogTitle>New folder</DialogTitle><DialogDescription>In {cwd}</DialogDescription></DialogHeader>
              <Input autoFocus aria-label="Folder name" value={draft} onChange={(e) => setDraft(e.target.value)} className="my-3" />
              <DialogFooter><Button type="submit" disabled={!draft.trim() || busy}>Create</Button></DialogFooter>
            </form>
          )}
          {dialog?.kind === "rename" && (
            <form onSubmit={(e) => { e.preventDefault(); void act(() => post({ op: "rename", path: dialog.entry.path, name: draft }), gone(dialog.entry)); }}>
              <DialogHeader><DialogTitle>Rename</DialogTitle><DialogDescription>{dialog.entry.path}</DialogDescription></DialogHeader>
              <Input autoFocus aria-label="New name" value={draft} onChange={(e) => setDraft(e.target.value)} className="my-3" />
              <DialogFooter><Button type="submit" disabled={!draft.trim() || draft === dialog.entry.name || busy}>Rename</Button></DialogFooter>
            </form>
          )}
          {dialog?.kind === "move" && (
            <form onSubmit={(e) => { e.preventDefault(); void act(() => post({ op: "move", path: dialog.entry.path, to: draft }), gone(dialog.entry)); }}>
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
                  onClick={() => act(() => post({ op: "delete", path: dialog.entry.path, force: dialog.force }), gone(dialog.entry))}>
                  <Trash2 className="size-4" /> Move to the trash
                </Button>
              </DialogFooter>
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
