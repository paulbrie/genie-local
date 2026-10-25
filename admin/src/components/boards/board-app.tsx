"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSubject } from "subjecto/react";
import {
  ArrowLeft,
  BringToFront,
  Circle,
  Copy,
  Diamond,
  Eraser,
  Frame,
  Hand,
  ImagePlus,
  Maximize,
  MessageCircle,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Redo2,
  SendToBack,
  Sparkles,
  Square,
  StickyNote,
  Trash2,
  Triangle,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { BASE_PATH } from "@/lib/config";
import {
  CLAUDE_COLOR,
  CLAUDE_ID,
  COLORS,
  contentBounds,
  INKS,
  maxZ,
  minZ,
  newId,
  PARTICIPANT_COLORS,
  SHAPES,
  type Author,
  type BoardObject,
  type CommentObj,
  type ShapeKind,
} from "@/lib/boards/core.mjs";
import { cn } from "@/lib/utils";

import { BoardCanvas, cloneObjects, DEFAULT_TOOL_OPTIONS, isTyping, type Tool, type ToolOptions } from "./board-canvas";
import { Avatar, ClaudePanel, CommentPopover, TimerControl, VotingControl } from "./board-panels";
import { bounds, fitView, unionRect, zoomAt, type Pt, type View } from "./geometry";
import { identity, loadIdentity, randomColor, saveIdentity } from "./identity";
import { BoardSync, type Peer } from "./sync";

// ------------------------------------------------------------------ identity

function IdentityDialog({ open, initial, onDone }: { open: boolean; initial: Author | null; onDone: (u: Author) => void }) {
  // Remounted (keyed) each time it opens, so these start from `initial`.
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState(() => initial?.color ?? randomColor());
  const ok = name.trim().length > 0;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && initial && onDone(initial)}>
      <DialogContent showCloseButton={!!initial}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) onDone(saveIdentity(name, color));
          }}
        >
          <DialogHeader>
            <DialogTitle>{initial ? "Your name on boards" : "Join the board"}</DialogTitle>
            <DialogDescription>
              Everyone shares the admin login, so pick the name and cursor colour others will see. It&apos;s kept in this
              browser.
            </DialogDescription>
          </DialogHeader>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" maxLength={40} data-testid="identity-name" />
          <div className="flex gap-2">
            {PARTICIPANT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={cn("size-7 rounded-full ring-offset-2 ring-offset-background", color === c && "ring-2 ring-foreground")}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={c}
              />
            ))}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!ok} data-testid="identity-join">
              {initial ? "Save" : "Join"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ toolbar

const TOOLS: { tool: Tool; icon: typeof Hand; label: string; key: string }[] = [
  { tool: "select", icon: MousePointer2, label: "Select", key: "V" },
  { tool: "hand", icon: Hand, label: "Hand (or hold space)", key: "H" },
  { tool: "sticky", icon: StickyNote, label: "Sticky note", key: "S" },
  { tool: "text", icon: Type, label: "Text", key: "T" },
  { tool: "shape", icon: Square, label: "Shape", key: "R" },
  { tool: "section", icon: Frame, label: "Section", key: "F" },
  { tool: "connector", icon: MoveUpRight, label: "Connector", key: "L" },
  { tool: "pen", icon: Pencil, label: "Pen", key: "P" },
  { tool: "eraser", icon: Eraser, label: "Eraser (pen strokes)", key: "E" },
  { tool: "comment", icon: MessageCircle, label: "Comment", key: "C" },
];

const SHAPE_ICONS: Record<ShapeKind, typeof Square> = {
  rect: Square,
  roundrect: Square,
  ellipse: Circle,
  diamond: Diamond,
  triangle: Triangle,
};

function Swatches({
  colors,
  value,
  onPick,
  small,
  nowrap,
}: {
  colors: string[];
  value?: string;
  onPick: (c: string) => void;
  small?: boolean;
  nowrap?: boolean;
}) {
  return (
    <div className={cn("flex gap-1", nowrap ? "flex-nowrap" : "flex-wrap")}>
      {colors.map((c) => (
        <button
          key={c}
          className={cn(
            "rounded-full border border-black/15",
            small ? "size-5" : "size-6",
            value === c && "ring-2 ring-blue-500 ring-offset-1 ring-offset-background",
          )}
          style={{ background: c }}
          onClick={() => onPick(c)}
          aria-label={c}
          title={c}
        />
      ))}
    </div>
  );
}

function ToolRail({
  tool,
  setTool,
  options,
  setOptions,
  onImage,
  sync,
}: {
  tool: Tool;
  setTool: (t: Tool) => void;
  options: ToolOptions;
  setOptions: (o: ToolOptions) => void;
  onImage: () => void;
  sync: BoardSync;
}) {
  const [canUndo] = useSubject(sync.canUndo);
  const [canRedo] = useSubject(sync.canRedo);
  return (
    <div
      className="absolute left-3 top-1/2 z-30 flex -translate-y-1/2 items-start gap-2"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col gap-0.5 rounded-xl border bg-background/95 p-1 shadow-lg backdrop-blur">
        {TOOLS.map(({ tool: t, icon: Icon, label, key }) => (
          <Button
            key={t}
            size="icon"
            variant={tool === t ? "default" : "ghost"}
            title={`${label} (${key})`}
            onClick={() => setTool(t)}
            data-testid={`tool-${t}`}
          >
            <Icon />
          </Button>
        ))}
        <Button size="icon" variant="ghost" title="Image (or paste / drop one)" onClick={onImage}>
          <ImagePlus />
        </Button>
        <div className="my-0.5 h-px bg-border" />
        <Button size="icon" variant="ghost" title="Undo (⌘Z)" disabled={!canUndo} onClick={() => sync.undo()}>
          <Undo2 />
        </Button>
        <Button size="icon" variant="ghost" title="Redo (⇧⌘Z)" disabled={!canRedo} onClick={() => sync.redo()}>
          <Redo2 />
        </Button>
      </div>
      {(tool === "sticky" || tool === "shape" || tool === "pen") && (
        <div className="w-40 space-y-2 rounded-xl border bg-background/95 p-2 shadow-lg backdrop-blur">
          {tool === "sticky" && (
            <Swatches colors={Object.values(COLORS)} value={options.stickyColor} onPick={(c) => setOptions({ ...options, stickyColor: c })} />
          )}
          {tool === "shape" && (
            <div className="flex flex-wrap gap-1">
              {SHAPES.map((s) => {
                const Icon = SHAPE_ICONS[s];
                return (
                  <Button
                    key={s}
                    size="icon-sm"
                    variant={options.shape === s ? "default" : "outline"}
                    title={s}
                    onClick={() => setOptions({ ...options, shape: s })}
                  >
                    <Icon className={s === "roundrect" ? "rounded" : undefined} />
                  </Button>
                );
              })}
            </div>
          )}
          {tool === "pen" && (
            <>
              <Swatches colors={Object.values(INKS)} value={options.penColor} onPick={(c) => setOptions({ ...options, penColor: c })} small />
              <div className="flex gap-1">
                {[2, 4, 8, 14].map((w) => (
                  <Button key={w} size="icon-sm" variant={options.penWidth === w ? "default" : "outline"} onClick={() => setOptions({ ...options, penWidth: w })}>
                    <span className="rounded-full bg-current" style={{ width: Math.min(14, w + 2), height: Math.min(14, w + 2) }} />
                  </Button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ selection toolbar

function SelectionBar({
  sync,
  objs,
  screen,
  area,
  onAskClaude,
  onDuplicate,
}: {
  sync: BoardSync;
  objs: BoardObject[];
  screen: { x: number; y: number };
  area: { w: number; h: number };
  onAskClaude: () => void;
  onDuplicate: () => void;
}) {
  const doc = sync.doc.getValue();
  const types = new Set(objs.map((o) => o.type));
  const only = types.size === 1 ? objs[0].type : null;
  const patchAll = (set: Record<string, unknown>, filter?: (o: BoardObject) => boolean) =>
    sync.apply(objs.filter((o) => !filter || filter(o)).map((o) => ({ k: "patch" as const, id: o.id, set })));
  const fills = only === "sticky" || only === "shape" || only === "section";
  const inks = only === "text" || only === "pen" || only === "connector";
  const first = objs[0] as BoardObject & Record<string, unknown>;

  return (
    <div
      className="absolute z-30 flex w-max -translate-x-1/2 items-center gap-1 rounded-xl border bg-background/95 px-1.5 py-1 shadow-lg backdrop-blur"
      // Kept on screen (it's about 520px wide at most).
      style={{ left: Math.min(Math.max(screen.x, 270), area.w - 270), top: Math.max(60, screen.y - 56) }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      data-testid="selection-bar"
    >
      {fills && (
        <Swatches
          small
          nowrap
          colors={only === "section" ? ["#f4f4f5", ...Object.values(COLORS).slice(0, 8)] : Object.values(COLORS)}
          value={first.color as string}
          onPick={(c) => patchAll({ color: c })}
        />
      )}
      {inks && <Swatches small nowrap colors={Object.values(INKS)} value={first.color as string} onPick={(c) => patchAll({ color: c })} />}
      {only === "shape" && (
        <div className="ml-1 flex gap-0.5 border-l pl-1">
          {SHAPES.map((s) => {
            const Icon = SHAPE_ICONS[s];
            return (
              <Button key={s} size="icon-xs" variant={first.shape === s ? "secondary" : "ghost"} title={s} onClick={() => patchAll({ shape: s })}>
                <Icon />
              </Button>
            );
          })}
        </div>
      )}
      {only === "text" && (
        <div className="ml-1 flex gap-0.5 border-l pl-1">
          {[14, 20, 32, 48, 72].map((s) => (
            <Button key={s} size="xs" variant={first.fontSize === s ? "secondary" : "ghost"} onClick={() => patchAll({ fontSize: s })}>
              {s}
            </Button>
          ))}
        </div>
      )}
      {only === "connector" && (
        <div className="ml-1 flex gap-0.5 border-l pl-1">
          {(["end", "both", "none"] as const).map((a) => (
            <Button key={a} size="xs" variant={first.arrow === a ? "secondary" : "ghost"} onClick={() => patchAll({ arrow: a })}>
              {a === "end" ? "→" : a === "both" ? "↔" : "—"}
            </Button>
          ))}
          <Button size="xs" variant={first.dashed ? "secondary" : "ghost"} onClick={() => patchAll({ dashed: first.dashed ? null : true })}>
            ┄
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              const label = window.prompt("Label", (first.label as string) ?? "");
              if (label !== null) patchAll({ label });
            }}
          >
            Label
          </Button>
        </div>
      )}
      <div className="ml-1 flex gap-0.5 border-l pl-1">
        <Button size="icon-xs" variant="ghost" title="Bring to front" onClick={() => {
          let z = maxZ(doc);
          sync.apply(objs.filter((o) => o.type !== "section").map((o) => ({ k: "patch" as const, id: o.id, set: { z: ++z } })));
        }}>
          <BringToFront />
        </Button>
        <Button size="icon-xs" variant="ghost" title="Send to back" onClick={() => {
          let z = minZ(doc);
          sync.apply(objs.map((o) => ({ k: "patch" as const, id: o.id, set: { z: --z } })));
        }}>
          <SendToBack />
        </Button>
        <Button size="icon-xs" variant="ghost" title="Duplicate (⌘D)" onClick={onDuplicate}>
          <Copy />
        </Button>
        <Button size="icon-xs" variant="ghost" title="Delete (⌫)" onClick={() => sync.apply(objs.map((o) => ({ k: "del" as const, id: o.id })))}>
          <Trash2 />
        </Button>
        <Button size="xs" variant="ghost" className="text-[#d97757]" title="Ask Claude about the selection" onClick={onAskClaude}>
          <Sparkles /> Ask
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ participants

function Participants({
  me,
  peers,
  claudeBusy,
  following,
  onFollow,
  onEditMe,
}: {
  me: Author;
  peers: Record<string, Peer>;
  claudeBusy: boolean;
  following: string | null;
  onFollow: (pid: string | null) => void;
  onEditMe: () => void;
}) {
  // One avatar per person (several tabs collapse); Claude always shown.
  const people = new Map<string, Peer>();
  for (const p of Object.values(peers)) if (p.user.id !== me.id && !people.has(p.user.id)) people.set(p.user.id, p);
  const claude = people.get(CLAUDE_ID);
  people.delete(CLAUDE_ID);
  return (
    <div className="flex items-center -space-x-1.5" data-testid="participants">
      <button
        className={cn("relative rounded-full", following === "bot:claude" && "ring-2 ring-[#d97757] ring-offset-2 ring-offset-background")}
        title={claude ? `Claude (${claudeBusy ? "working" : "here"}) - click to follow` : "Claude"}
        onClick={() => onFollow(following === "bot:claude" ? null : "bot:claude")}
      >
        <Avatar user={{ id: CLAUDE_ID, name: "Claude", color: CLAUDE_COLOR }} ring className={cn(claudeBusy && "animate-pulse")} />
      </button>
      {[...people.values()].map((p) => (
        <button
          key={p.pid}
          className={cn("rounded-full", following === p.pid && "ring-2 ring-offset-2 ring-offset-background")}
          style={following === p.pid ? ({ "--tw-ring-color": p.user.color } as React.CSSProperties) : undefined}
          title={`${p.user.name}${p.kind === "agent" ? " (agent)" : ""} - click to follow`}
          onClick={() => onFollow(following === p.pid ? null : p.pid)}
        >
          <Avatar user={p.user} ring />
        </button>
      ))}
      <button className="rounded-full" title={`You (${me.name}) - change name`} onClick={onEditMe}>
        <Avatar user={me} ring className="outline-2 outline-offset-1 outline-dashed outline-muted-foreground/40" />
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ app

const REACTIONS = ["👍", "❤️", "🎉", "😂", "🤔", "👀", "🔥", "➕"];

export function BoardApp({ boardId, initialTitle }: { boardId: number; initialTitle: string }) {
  const [me] = useSubject(identity);
  const [editMe, setEditMe] = useState(false);
  useEffect(() => loadIdentity(), []);

  if (me === undefined) return null;
  return (
    <>
      <IdentityDialog
        key={!me || editMe ? "open" : "closed"}
        open={!me || editMe}
        initial={me}
        onDone={() => {
          setEditMe(false);
        }}
      />
      {me && <Board boardId={boardId} initialTitle={initialTitle} me={me} onEditMe={() => setEditMe(true)} />}
    </>
  );
}

function Board({ boardId, initialTitle, me, onEditMe }: { boardId: number; initialTitle: string; me: Author; onEditMe: () => void }) {
  const sync = useMemo(() => new BoardSync(boardId, me), [boardId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    sync.connect();
    return () => sync.close();
  }, [sync]);
  useEffect(() => sync.setUser(me), [sync, me]);

  const [doc] = useSubject(sync.doc);
  const [peers] = useSubject(sync.peers);
  const [status] = useSubject(sync.status);
  const [title] = useSubject(sync.title);
  const [claudeBusy] = useSubject(sync.claudeBusy);
  const [reactions] = useSubject(sync.reactions);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ tx: 0, ty: 0, zoom: 1 });
  const viewRef = useRef(view);
  useLayoutEffect(() => {
    viewRef.current = view;
  }, [view]);
  const [tool, setTool] = useState<Tool>("select");
  const [toolOptions, setToolOptions] = useState<ToolOptions>(DEFAULT_TOOL_OPTIONS);
  const [rawSelection, setSelectionState] = useState<string[]>([]);
  const [editing, setEditingState] = useState<string | null>(null);
  const [claudeOpen, setClaudeOpen] = useState(false);
  // Clicking "Ask" on a selection opens the panel ready to type; opening it any
  // other way leaves the keyboard on the canvas, where the shortcuts live.
  const [askNonce, setAskNonce] = useState(0);
  const [comment, setComment] = useState<{ id: string } | { at: Pt } | null>(null);
  const [following, setFollowing] = useState<string | null>(null);
  const pointer = useRef<Pt | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const clipboard = useRef<BoardObject[] | null>(null);
  const fitted = useRef(false);

  const setSelection = useCallback(
    (ids: string[]) => {
      setSelectionState(ids);
      sync.presence({ selection: ids });
    },
    [sync],
  );
  const setEditing = useCallback(
    (id: string | null) => {
      setEditingState(id);
      sync.presence({ editing: id });
    },
    [sync],
  );

  // What someone else deleted drops out of the selection.
  const selection = useMemo(() => rawSelection.filter((id) => doc.objects[id]), [rawSelection, doc.objects]);

  // The board's on-screen size, for placing popovers during render.
  const [area, setArea] = useState({ w: 1200, h: 800 });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setArea({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const size = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    return { w: r?.width ?? 1200, h: r?.height ?? 800 };
  };
  // Keeps the off-screen peer markers clear of the top bar, the tool rail, the
  // reaction and zoom bars, and the Claude panel when it's open.
  const insets = useMemo(
    () => ({ top: 68, right: claudeOpen ? 360 : 60, bottom: 68, left: 60 }),
    [claudeOpen],
  );

  const worldViewport = useCallback(() => {
    const { w, h } = size();
    const v = viewRef.current;
    return { x: -v.tx / v.zoom, y: -v.ty / v.zoom, w: w / v.zoom, h: h / v.zoom };
  }, []);

  // First load: fit the content.
  useEffect(() => {
    const sub = sync.status.subscribe((s) => {
      if (s !== "live" || fitted.current) return;
      fitted.current = true;
      const { w, h } = size();
      setView(fitView(contentBounds(sync.doc.getValue()), w, h));
    });
    return () => sub.unsubscribe();
  }, [sync]);

  // Tell the others what we're looking at (for follow mode).
  useEffect(() => {
    sync.presence({ viewport: worldViewport() });
  }, [view, sync, worldViewport]);

  // Follow mode: keep the followed person's view (or Claude's cursor) centred.
  useEffect(() => {
    if (!following) return;
    const sub = sync.peers.subscribe((all) => {
      const p = all[following];
      if (!p) {
        // Claude comes and goes; people who leave end the follow.
        if (following !== "bot:claude") setFollowing(null);
        return;
      }
      const { w, h } = size();
      if (p.viewport) {
        setView(fitView(p.viewport, w, h, 4, 0));
      } else if (p.cursor) {
        const c = p.cursor;
        setView((v) => ({ ...v, tx: w / 2 - c.x * v.zoom, ty: h / 2 - c.y * v.zoom }));
      }
    });
    return () => sub.unsubscribe();
  }, [following, sync]);

  const stopFollowing = useCallback(() => setFollowing(null), []);
  const onPointerWorld = useCallback((p: Pt | null) => {
    pointer.current = p;
  }, []);

  const fit = () => {
    const { w, h } = size();
    setView(fitView(contentBounds(doc), w, h));
  };
  const zoomBy = (f: number) => {
    const { w, h } = size();
    setView((v) => zoomAt(v, w / 2, h / 2, v.zoom * f));
  };

  // ------------------------------------------------------------ images
  const uploadImages = useCallback(
    async (files: File[], at: Pt) => {
      let dx = 0;
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        const t = toast.loading(`Uploading ${file.name || "image"}…`);
        try {
          const res = await fetch(`${BASE_PATH}/api/boards/${boardId}/assets`, { method: "POST", body: fd });
          const j = await res.json();
          if (!res.ok) throw new Error(j.error ?? res.statusText);
          const dims = await new Promise<{ w: number; h: number }>((resolve) => {
            const img = new Image();
            img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
            img.onerror = () => resolve({ w: 320, h: 240 });
            img.src = `${BASE_PATH}${j.src}`;
          });
          const scale = Math.min(1, 480 / Math.max(dims.w, dims.h));
          const w = Math.round(dims.w * scale);
          const h = Math.round(dims.h * scale);
          const id = newId("i");
          sync.apply([{ k: "put", obj: { id, type: "image", x: at.x - w / 2 + dx, y: at.y - h / 2, w, h, z: maxZ(sync.doc.getValue()) + 1, src: j.src, alt: file.name } }]);
          dx += w + 24;
          setSelection([id]);
          toast.success("Image added", { id: t });
        } catch (e) {
          toast.error(`Upload failed: ${(e as Error).message}`, { id: t });
        }
      }
    },
    [boardId, sync, setSelection],
  );

  const viewportCentre = () => {
    const vp = worldViewport();
    return { x: vp.x + vp.w / 2, y: vp.y + vp.h / 2 };
  };

  // ------------------------------------------------------------ clipboard / keys
  const duplicate = useCallback(
    (objs: BoardObject[], dx = 24, dy = 24) => {
      const d = sync.doc.getValue();
      const copies = cloneObjects(d, objs, dx, dy);
      if (!copies.length) return;
      sync.apply(copies.map((obj) => ({ k: "put" as const, obj })));
      setSelection(copies.map((c) => c.id));
    },
    [sync, setSelection],
  );

  useEffect(() => {
    const selectedObjs = () => {
      const d = sync.doc.getValue();
      return selection.map((id) => d.objects[id]).filter(Boolean);
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) sync.redo();
        else sync.undo();
        return;
      }
      if (mod && k === "y") {
        e.preventDefault();
        sync.redo();
        return;
      }
      if (mod && k === "a") {
        e.preventDefault();
        setSelection(Object.keys(sync.doc.getValue().objects));
        return;
      }
      if (mod && k === "d") {
        e.preventDefault();
        duplicate(selectedObjs());
        return;
      }
      if (mod && (k === "0" || k === "1")) {
        e.preventDefault();
        if (k === "1") fit();
        else setView((v) => zoomAt(v, size().w / 2, size().h / 2, 1));
        return;
      }
      if (mod && (k === "=" || k === "+" || k === "-")) {
        e.preventDefault();
        zoomBy(k === "-" ? 1 / 1.25 : 1.25);
        return;
      }
      if (mod) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        const objs = selectedObjs();
        if (objs.length) {
          e.preventDefault();
          sync.apply(objs.map((o) => ({ k: "del" as const, id: o.id })));
        }
        return;
      }
      if (e.key === "Escape") {
        setSelection([]);
        setTool("select");
        setComment(null);
        setFollowing(null);
        return;
      }
      if (e.key === "Enter" && selection.length === 1) {
        const o = sync.doc.getValue().objects[selection[0]];
        if (o && ["sticky", "text", "shape", "section"].includes(o.type)) {
          e.preventDefault();
          setEditing(o.id);
        }
        return;
      }
      if (e.key.startsWith("Arrow") && selection.length) {
        e.preventDefault();
        const step = e.shiftKey ? 20 : 2;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        sync.apply(
          selectedObjs()
            .filter((o) => o.type !== "connector")
            .map((o) => ({ k: "patch" as const, id: o.id, set: { x: o.x + dx, y: o.y + dy } })),
        );
        return;
      }
      if (e.shiftKey && k === "1") {
        fit();
        return;
      }
      const t = TOOLS.find((x) => x.key.toLowerCase() === k);
      if (t) setTool(t.tool);
      else if (k === "o") {
        setToolOptions((o) => ({ ...o, shape: "ellipse" }));
        setTool("shape");
      }
    };
    const onCopy = (e: ClipboardEvent) => {
      if (isTyping(e as unknown as KeyboardEvent)) return;
      const objs = selectedObjs();
      if (!objs.length) return;
      clipboard.current = objs;
      e.clipboardData?.setData("text/plain", objs.map((o) => ("text" in o ? o.text : "title" in o ? o.title : "")).filter(Boolean).join("\n"));
      e.clipboardData?.setData("application/x-board-objects", JSON.stringify(objs));
      e.preventDefault();
    };
    const onCut = (e: ClipboardEvent) => {
      onCopy(e);
      if (clipboard.current && !isTyping(e as unknown as KeyboardEvent)) {
        sync.apply(clipboard.current.map((o) => ({ k: "del" as const, id: o.id })));
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e as unknown as KeyboardEvent)) return;
      const at = pointer.current ?? viewportCentre();
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length) {
        e.preventDefault();
        uploadImages(files, at);
        return;
      }
      const raw = e.clipboardData?.getData("application/x-board-objects");
      let objs: BoardObject[] | null = null;
      try {
        objs = raw ? JSON.parse(raw) : clipboard.current;
      } catch {
        objs = clipboard.current;
      }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (objs?.length && (raw || !text)) {
        e.preventDefault();
        const b = unionRect(objs.map((o) => bounds(sync.doc.getValue(), o)));
        duplicate(objs, b ? at.x - (b.x + b.w / 2) : 24, b ? at.y - (b.y + b.h / 2) : 24);
        return;
      }
      if (text.trim()) {
        // Pasted text: one sticky per line (up to 50), in a grid.
        e.preventDefault();
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 50);
        const cols = Math.ceil(Math.sqrt(lines.length));
        let z = maxZ(sync.doc.getValue());
        const ops = lines.map((line, i) => ({
          k: "put" as const,
          obj: {
            id: newId("s"),
            type: "sticky" as const,
            x: at.x + (i % cols) * 220 - 100,
            y: at.y + Math.floor(i / cols) * 220 - 100,
            w: 200,
            h: 200,
            z: ++z,
            text: line,
            color: toolOptions.stickyColor,
          },
        }));
        sync.apply(ops);
        setSelection(ops.map((o) => o.obj.id));
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("copy", onCopy);
    window.addEventListener("cut", onCut);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("cut", onCut);
      window.removeEventListener("paste", onPaste);
    };
  });

  // ------------------------------------------------------------ render
  const selectedObjs = selection.map((id) => doc.objects[id]).filter(Boolean);
  const selRect = unionRect(selectedObjs.map((o) => bounds(doc, o)));
  const selScreen = selRect
    ? { x: (selRect.x + selRect.w / 2) * view.zoom + view.tx, y: selRect.y * view.zoom + view.ty }
    : null;

  const openComment = comment && "id" in comment ? (doc.objects[comment.id] as CommentObj | undefined) : null;
  const commentWorld = openComment ? { x: openComment.x, y: openComment.y } : comment && "at" in comment ? comment.at : null;

  const renameTitle = async () => {
    const t = window.prompt("Board name", title || initialTitle);
    if (!t?.trim()) return;
    const res = await fetch(`${BASE_PATH}/api/boards/${boardId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: t.trim() }),
    });
    if (!res.ok) toast.error("Couldn't rename the board");
  };

  if (status === "missing" || status === "closed") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        {status === "missing" ? "This board doesn't exist (or is archived)." : "This board was archived."}
        <Link href="/boards" className="underline">
          Back to boards
        </Link>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden" data-testid="board">
      <BoardCanvas
        sync={sync}
        doc={doc}
        me={me.id}
        myColor={me.color}
        peers={peers}
        reactions={reactions}
        view={view}
        setView={setView}
        tool={tool}
        setTool={setTool}
        toolOptions={toolOptions}
        selection={selection}
        setSelection={setSelection}
        editing={editing}
        setEditing={setEditing}
        onOpenComment={setComment}
        onDropFiles={uploadImages}
        onUserPan={stopFollowing}
        onPointerWorld={onPointerWorld}
        area={area}
        onFollowPeer={setFollowing}
        insets={insets}
      />

      {/* Top bar */}
      <div
        className="absolute inset-x-3 top-3 z-30 flex items-center gap-2"
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="flex min-w-0 items-center gap-1 rounded-xl border bg-background/95 py-1 pl-1 pr-3 shadow-lg backdrop-blur">
          <Link href="/boards" title="All boards">
            <Button size="icon-sm" variant="ghost">
              <ArrowLeft />
            </Button>
          </Link>
          <button className="truncate text-sm font-semibold hover:underline" onClick={renameTitle} title="Rename" data-testid="board-title">
            {title || initialTitle}
          </button>
          <span
            className={cn(
              "ml-1 size-2 shrink-0 rounded-full",
              status === "live" ? "bg-emerald-500" : status === "connecting" ? "animate-pulse bg-amber-500" : "bg-red-500",
            )}
            title={status === "live" ? "Live" : status === "connecting" ? "Connecting…" : "Offline, reconnecting…"}
          />
          {status === "offline" && <span className="text-xs text-red-600">reconnecting…</span>}
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 rounded-xl border bg-background/95 px-2 py-1 shadow-lg backdrop-blur">
          <VotingControl sync={sync} doc={doc} />
          <TimerControl sync={sync} meta={doc.meta} />
          <div className="mx-1 h-5 w-px bg-border" />
          <Participants
            me={me}
            peers={peers}
            claudeBusy={claudeBusy}
            following={following}
            onFollow={setFollowing}
            onEditMe={onEditMe}
          />
          <div className="mx-1 h-5 w-px bg-border" />
          <Button
            size="sm"
            variant={claudeOpen ? "default" : "outline"}
            className={cn(!claudeOpen && "border-[#d97757]/50 text-[#d97757]")}
            onClick={() => {
              setClaudeOpen((o) => !o);
              setAskNonce(0);
            }}
            data-testid="claude-toggle"
          >
            <Sparkles /> Claude
          </Button>
        </div>
      </div>

      {following && (
        <div className="absolute inset-x-0 top-16 z-30 flex justify-center" onPointerDown={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-2 rounded-full bg-foreground px-3 py-1 text-xs text-background shadow">
            Following {peers[following]?.user.name ?? "Claude"}
            <button className="underline" onClick={() => setFollowing(null)}>
              stop
            </button>
          </div>
        </div>
      )}

      <ToolRail tool={tool} setTool={setTool} options={toolOptions} setOptions={setToolOptions} onImage={() => fileRef.current?.click()} sync={sync} />
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) uploadImages(files, viewportCentre());
        }}
      />

      {selScreen && selectedObjs.some((o) => o.type !== "comment") && !editing && tool === "select" && (
        <SelectionBar
          sync={sync}
          objs={selectedObjs}
          screen={selScreen}
          area={area}
          onDuplicate={() => duplicate(selectedObjs)}
          onAskClaude={() => {
            setClaudeOpen(true);
            setAskNonce((n) => n + 1);
          }}
        />
      )}

      {comment && commentWorld && (
        <CommentPopover
          key={"id" in comment ? comment.id : "new"}
          sync={sync}
          comment={openComment ?? null}
          at={"at" in comment ? comment.at : null}
          screen={{ x: commentWorld.x * view.zoom + view.tx, y: commentWorld.y * view.zoom + view.ty }}
          area={area}
          onClose={() => setComment(null)}
        />
      )}

      {claudeOpen && (
        <ClaudePanel
          sync={sync}
          doc={doc}
          busy={claudeBusy}
          selection={selection}
          viewport={worldViewport}
          onClose={() => {
            setClaudeOpen(false);
            setAskNonce(0);
          }}
          onToggleFacilitator={() => sync.send1([{ k: "meta", set: { facilitator: !doc.meta.facilitator } }])}
          focusAt={askNonce}
        />
      )}

      {/* Bottom: reactions + zoom */}
      <div
        className={cn(
          "absolute bottom-3 z-30 flex -translate-x-1/2 gap-0.5 rounded-full border bg-background/95 px-1.5 py-1 shadow-lg backdrop-blur",
          // Centred in what the Claude panel leaves free.
          claudeOpen ? "left-[calc(50%-170px)]" : "left-1/2",
        )}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {REACTIONS.map((r) => (
          <button
            key={r}
            className="rounded-full px-1 text-lg transition-transform hover:scale-125"
            title="React"
            onClick={() => sync.react(r, pointer.current ?? viewportCentre())}
          >
            {r}
          </button>
        ))}
      </div>
      <div
        className={cn("absolute bottom-3 z-30 flex items-center gap-0.5 rounded-xl border bg-background/95 p-1 shadow-lg backdrop-blur", claudeOpen ? "right-[356px]" : "right-3")}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Button size="icon-sm" variant="ghost" title="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
          <ZoomOut />
        </Button>
        <button className="w-12 text-center text-xs tabular-nums" title="Reset to 100%" onClick={() => setView((v) => zoomAt(v, size().w / 2, size().h / 2, 1))}>
          {Math.round(view.zoom * 100)}%
        </button>
        <Button size="icon-sm" variant="ghost" title="Zoom in" onClick={() => zoomBy(1.25)}>
          <ZoomIn />
        </Button>
        <Button size="icon-sm" variant="ghost" title="Fit everything (⇧1)" onClick={fit}>
          <Maximize />
        </Button>
      </div>

      {status === "connecting" && Object.keys(doc.objects).length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">Connecting…</div>
      )}
    </div>
  );
}
