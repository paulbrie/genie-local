"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  COLORS,
  DEFAULT_SIZES,
  hiddenByCollapsed,
  INKS,
  maxZ,
  minZ,
  newId,
  type BoardDoc,
  type BoardObject,
  type Connector,
  type ConnectorEnd,
  type ShapeKind,
} from "@/lib/boards/core.mjs";
import { cn } from "@/lib/utils";

import {
  attachTarget,
  bounds,
  edgePoint,
  connectorCurve,
  contains,
  hitTest,
  intersects,
  normRect,
  offScreen,
  nearBorder,
  nearestAnchor,
  penHit,
  penPath,
  simplify,
  toWorld,
  unionRect,
  zoomAt,
  type Insets,
  type Pt,
  type Rect,
  type View,
} from "./geometry";
import { initials } from "./identity";
import { ConnectorView, ObjectView, type EditingCell, type ObjectHandlers } from "./objects";
import type { BoardSync, Gesture, Peer, Reaction } from "./sync";

export type Tool =
  | "select"
  | "hand"
  | "sticky"
  | "text"
  | "shape"
  | "section"
  | "connector"
  | "pen"
  | "eraser"
  | "comment"
  | "link"
  | "table";

export type ToolOptions = {
  stickyColor: string;
  shape: ShapeKind;
  penColor: string;
  penWidth: number;
};

export const DEFAULT_TOOL_OPTIONS: ToolOptions = {
  stickyColor: COLORS.yellow,
  shape: "rect",
  penColor: INKS.black,
  penWidth: 3,
};

type Handle = "nw" | "ne" | "sw" | "se";

type Drag =
  | { kind: "pan"; sx: number; sy: number; view: View }
  | { kind: "marquee"; start: Pt; cur: Pt; base: string[] }
  | {
      kind: "move";
      start: Pt;
      ids: string[];
      origins: Map<string, { x: number; y: number; from?: ConnectorEnd; to?: ConnectorEnd }>;
      g: Gesture;
      moved: boolean;
      clickId: string;
      additive: boolean;
    }
  | { kind: "resize"; id: string; handle: Handle; rect: Rect; start: Pt; g: Gesture; keepRatio: boolean }
  | { kind: "create"; id: string; start: Pt; g: Gesture; type: "shape" | "section" }
  | { kind: "connect"; from: ConnectorEnd; cur: Pt }
  | { kind: "endpoint"; id: string; which: "from" | "to"; g: Gesture }
  | { kind: "pen"; points: [number, number][] }
  | { kind: "erase"; g: Gesture; erased: Set<string> }
  | { kind: "bend"; id: string; g: Gesture };

type Props = {
  sync: BoardSync;
  doc: BoardDoc;
  me: string;
  myColor: string;
  peers: Record<string, Peer>;
  reactions: Reaction[];
  view: View;
  setView: (v: View | ((v: View) => View)) => void;
  tool: Tool;
  setTool: (t: Tool) => void;
  toolOptions: ToolOptions;
  selection: string[];
  setSelection: (ids: string[]) => void;
  editing: string | null;
  setEditing: (id: string | null) => void;
  onOpenComment: (target: { id: string } | { at: Pt }) => void;
  onDropFiles: (files: File[], at: Pt) => void;
  onUserPan: () => void;
  /** The canvas's size on screen, for the off-screen peer markers. */
  area: { w: number; h: number };
  /** Click an off-screen marker to follow that person. */
  onFollowPeer: (pid: string) => void;
  /** Where the toolbars and panels cover the canvas, so markers stay visible. */
  insets: Insets;
  /** Looking at the past: you can move around it, but not change it. */
  readOnly?: boolean;
  /** The table cell open for typing, and how to move between them. */
  cell: EditingCell;
  setCell: (cell: EditingCell) => void;
  /** The world point under the pointer, null when it leaves (for paste and reactions). */
  onPointerWorld: (p: Pt | null) => void;
};

const HANDLE_PX = 10;


export function BoardCanvas(props: Props) {
  const {
    sync,
    doc,
    me,
    myColor,
    peers,
    reactions,
    view,
    setView,
    tool,
    setTool,
    toolOptions,
    selection,
    setSelection,
    editing,
    setEditing,
    onOpenComment,
    onDropFiles,
    onUserPan,
    onPointerWorld,
    area,
    onFollowPeer,
    insets,
    readOnly = false,
    cell,
    setCell,
  } = props;

  const rootRef = useRef<HTMLDivElement>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const [space, setSpace] = useState(false);
  // What a connector would attach to right now, so you can see where it lands
  // before letting go. Kept in a ref too: the pointer moves far more often than
  // this changes, and only a change is worth a re-render.
  const [snap, setSnapState] = useState<string | null>(null);
  // Exactly where a dragged end would land, when it's near a border.
  const [anchorDot, setAnchorDot] = useState<Pt | null>(null);
  const snapRef = useRef<string | null>(null);
  const setSnap = (id: string | null) => {
    if (snapRef.current === id) return;
    snapRef.current = id;
    setSnapState(id);
  };

  // Handlers read the latest values through refs (they're attached once).
  const live = useRef({ doc, view, selection, tool, toolOptions, editing });
  useLayoutEffect(() => {
    live.current = { doc, view, selection, tool, toolOptions, editing };
  });

  const { sorted, foldedCounts } = useMemo(() => {
    const hidden = hiddenByCollapsed(doc);
    const counts = new Map();
    for (const id of hidden) {
      const o = doc.objects[id];
      if (!o || o.type === "connector") continue;
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      for (const s of Object.values(doc.objects)) {
        if (s.type === "section" && s.collapsed && cx >= s.x && cx <= s.x + s.w && cy >= s.y && cy <= s.y + s.h) {
          counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
          break;
        }
      }
    }
    return {
      sorted: Object.values(doc.objects)
        .filter((o) => !hidden.has(o.id))
        .sort((a, b) => a.z - b.z),
      foldedCounts: counts,
    };
  }, [doc]);
  const sortedRef = useRef(sorted);
  useLayoutEffect(() => {
    sortedRef.current = sorted;
  }, [sorted]);

  const editGesture = useRef<{ id: string; g: Gesture } | null>(null);

  const handlers: ObjectHandlers = useMemo(
    () => ({
      onText: (id, text, h) => {
        const o = live.current.doc.objects[id];
        if (!o) return;
        if (!editGesture.current || editGesture.current.id !== id) editGesture.current = { id, g: sync.gesture() };
        const set: Record<string, unknown> = o.type === "section" ? { title: text } : { text };
        if (h !== undefined && o.type === "text") set.h = Math.max(24, h);
        editGesture.current.g.apply([{ k: "patch", id, set }]);
      },
      onEditEnd: () => {
        const id = live.current.editing;
        const o = id ? live.current.doc.objects[id] : null;
        if (o && o.type === "text" && !o.text.trim()) {
          if (editGesture.current?.id === id) editGesture.current.g.apply([{ k: "del", id: o.id }]);
          else sync.apply([{ k: "del", id: o.id }]);
        }
        editGesture.current?.g.end();
        editGesture.current = null;
        setEditing(null);
      },
      onCell: (id, r, c, text, move) => {
        const o = live.current.doc.objects[id];
        if (o?.type !== "table") return;
        if (o.rows[r]?.[c] !== text) {
          const rows = o.rows.map((row, i) => (i === r ? row.map((v, j) => (j === c ? text : v)) : row));
          sync.apply([{ k: "patch", id, set: { rows } }]);
        }
        if (!move) return;
        // Walk on, wrapping at the ends of a row and stopping at the table's.
        const cols = o.rows[0].length;
        const flat = move === "down" ? (r + 1) * cols + c : r * cols + c + (move === "next" ? 1 : -1);
        const nr = move === "down" ? r + 1 : Math.floor(flat / cols);
        const nc = move === "down" ? c : ((flat % cols) + cols) % cols;
        if (nr >= 0 && nr < o.rows.length) setCell({ id, r: nr, c: nc });
      },
      onToggleCollapse: (id) => {
        const o = live.current.doc.objects[id];
        if (o?.type === "section") sync.apply([{ k: "patch", id, set: { collapsed: o.collapsed ? null : true } as never }]);
      },
      onAccept: (id) => sync.apply([{ k: "patch", id, set: { suggestion: null } as never }]),
      onDismiss: (id) => sync.apply([{ k: "del", id }]),
    }),
    [sync, setEditing, setCell],
  );

  // Close an edit session if the object vanished (someone deleted it).
  useEffect(() => {
    if (editing && !doc.objects[editing]) {
      editGesture.current?.g.end();
      editGesture.current = null;
      setEditing(null);
    }
  }, [doc.objects, editing, setEditing]);

  const screenPt = (e: { clientX: number; clientY: number }) => {
    const r = rootRef.current!.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  };
  const worldPt = (e: { clientX: number; clientY: number }) => {
    const { sx, sy } = screenPt(e);
    return toWorld(live.current.view, sx, sy);
  };

  // ---------------------------------------------------------- wheel / zoom
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      onUserPan();
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      if (e.ctrlKey || e.metaKey) {
        setView((v) => zoomAt(v, sx, sy, v.zoom * Math.exp(-e.deltaY * 0.01)));
      } else {
        setView((v) => ({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setView, onUserPan]);

  // Space held = temporary hand tool.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping(e)) {
        e.preventDefault();
        setSpace(true);
      }
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && setSpace(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // ---------------------------------------------------------- pointer
  const sectionChildren = (d: BoardDoc, sec: BoardObject) =>
    Object.values(d.objects)
      .filter((o) => o.id !== sec.id && o.type !== "connector" && o.type !== "section" && contains(sec, bounds(d, o)))
      .map((o) => o.id);

  const startMove = (p: Pt, ids: string[], clickId: string, additive: boolean) => {
    const d = live.current.doc;
    const all = new Set(ids);
    for (const id of ids) {
      const o = d.objects[id];
      if (o?.type === "section") for (const c of sectionChildren(d, o)) all.add(c);
    }
    const origins = new Map<string, { x: number; y: number; from?: ConnectorEnd; to?: ConnectorEnd }>();
    for (const id of all) {
      const o = d.objects[id];
      if (!o) continue;
      origins.set(id, o.type === "connector" ? { x: o.x, y: o.y, from: o.from, to: o.to } : { x: o.x, y: o.y });
    }
    setDrag({ kind: "move", start: p, ids: [...all], origins, g: sync.gesture(), moved: false, clickId, additive });
  };

  /**
   * Where on `target` an end dropped at `p` should land: the exact spot on the
   * border when the pointer is near one, nothing when it's dropped well inside,
   * which leaves the line free to pick its own side as things move.
   */
  const anchorAt = (target: BoardObject | null, p: Pt) =>
    target && nearBorder(target, p) ? nearestAnchor(target, p) : undefined;

  const create = (obj: Partial<BoardObject> & { type: BoardObject["type"] }, g?: Gesture) => {
    const d = live.current.doc;
    const id = newId(obj.type[0]);
    const z = obj.type === "section" ? minZ(d) - 1 : maxZ(d) + 1;
    const full = { id, z, ...obj } as BoardObject;
    // Inside a drag the caller's gesture is the undo step; otherwise this is one.
    if (g) g.apply([{ k: "put", obj: full }]);
    else sync.apply([{ k: "put", obj: full }]);
    return id;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    // No mousedown default: it would move focus to the page and blur the text
    // box a click with the sticky / text tool has just opened (and select text).
    e.preventDefault();
    rootRef.current?.setPointerCapture(e.pointerId);
    const { doc: d, view: v, tool: t, selection: sel, toolOptions: opts } = live.current;
    const p = worldPt(e);
    const { sx, sy } = screenPt(e);

    // With the default prevented, focus doesn't leave on its own: clicking the
    // board ends text editing (blur does the rest) and frees shortcut keys.
    (document.activeElement as HTMLElement | null)?.blur?.();

    // The past is read-only: you can still move around it.
    if (e.button === 1 || t === "hand" || space || readOnly) {
      onUserPan();
      setDrag({ kind: "pan", sx, sy, view: v });
      return;
    }

    switch (t) {
      case "sticky": {
        const s = DEFAULT_SIZES.sticky;
        const id = create({ type: "sticky", x: p.x - s.w / 2, y: p.y - s.h / 2, w: s.w, h: s.h, color: opts.stickyColor, text: "" });
        setSelection([id]);
        setEditing(id);
        setTool("select");
        return;
      }
      case "text": {
        const id = create({ type: "text", x: p.x, y: p.y - 14, w: 240, h: 30, text: "", fontSize: 20 });
        setSelection([id]);
        setEditing(id);
        setTool("select");
        return;
      }
      case "shape":
      case "section": {
        const g = sync.gesture();
        const id =
          t === "shape"
            ? create({ type: "shape", x: p.x, y: p.y, w: 1, h: 1, shape: opts.shape, text: "" }, g)
            : create({ type: "section", x: p.x, y: p.y, w: 1, h: 1, title: "Section" }, g);
        setSelection([id]);
        setDrag({ kind: "create", id, start: p, g, type: t });
        return;
      }
      case "connector": {
        const target = attachTarget(sortedRef.current, p);
        setDrag({ kind: "connect", from: target ? { id: target.id, x: p.x, y: p.y } : { x: p.x, y: p.y }, cur: p });
        return;
      }
      case "pen":
        setDrag({ kind: "pen", points: [[p.x, p.y]] });
        return;
      case "eraser":
        setDrag({ kind: "erase", g: sync.gesture(), erased: new Set() });
        eraseAt(p);
        return;
      case "link": {
        // Nothing to show without an address, so ask for it first.
        const raw = window.prompt("Link address");
        setTool("select");
        const url = raw?.trim();
        if (!url) return;
        const s = DEFAULT_SIZES.link;
        const id = create({ type: "link", x: p.x - s.w / 2, y: p.y - s.h / 2, w: s.w, h: s.h, url: /^https?:\/\//i.test(url) ? url : `https://${url}` } as Partial<BoardObject> & { type: "link" });
        setSelection([id]);
        return;
      }
      case "table": {
        const s = DEFAULT_SIZES.table;
        const id = create({
          type: "table",
          x: p.x - s.w / 2,
          y: p.y - s.h / 2,
          w: s.w,
          h: s.h,
          rows: [
            ["Column", "Column", "Column"],
            ["", "", ""],
            ["", "", ""],
          ],
        } as Partial<BoardObject> & { type: "table" });
        setSelection([id]);
        setCell({ id, r: 0, c: 0 });
        setTool("select");
        return;
      }
      case "comment": {
        const hit = hitTest(d, sortedRef.current, p, v.zoom);
        if (hit?.type === "comment") onOpenComment({ id: hit.id });
        else onOpenComment({ at: { x: p.x - 4, y: p.y - 28 } });
        setTool("select");
        return;
      }
    }

    // select tool: a handle of the single selection?
    if (sel.length === 1) {
      const o = d.objects[sel[0]];
      if (o) {
        const tol = HANDLE_PX / v.zoom;
        if (o.type === "connector") {
          const { a, b, mid } = connectorCurve(d, o);
          // The middle handle shapes the curve; grab it before the ends.
          if (!o.straight && Math.hypot(p.x - mid.x, p.y - mid.y) <= tol) {
            setDrag({ kind: "bend", id: o.id, g: sync.gesture() });
            return;
          }
          for (const [which, q] of [
            ["from", a],
            ["to", b],
          ] as const) {
            if (Math.hypot(p.x - q.x, p.y - q.y) <= tol) {
              setDrag({ kind: "endpoint", id: o.id, which, g: sync.gesture() });
              return;
            }
          }
        } else if (o.type !== "comment" && o.type !== "pen") {
          const corners: [Handle, number, number][] = [
            ["nw", o.x, o.y],
            ["ne", o.x + o.w, o.y],
            ["sw", o.x, o.y + o.h],
            ["se", o.x + o.w, o.y + o.h],
          ];
          for (const [handle, hx, hy] of corners) {
            if (Math.abs(p.x - hx) <= tol && Math.abs(p.y - hy) <= tol) {
              setDrag({
                kind: "resize",
                id: o.id,
                handle,
                rect: { x: o.x, y: o.y, w: o.w, h: o.h },
                start: p,
                g: sync.gesture(),
                keepRatio: o.type === "image" || o.type === "sticky",
              });
              return;
            }
          }
        }
      }
    }

    const hit = hitTest(d, sortedRef.current, p, v.zoom);

    // Voting: a click is a vote (alt / shift click takes one back).
    if (d.meta.voting && hit && hit.type !== "connector" && hit.type !== "comment" && hit.type !== "pen") {
      sync.send1([{ k: "vote", id: hit.id, delta: e.altKey || e.shiftKey ? -1 : 1 }]);
      return;
    }

    if (hit?.type === "comment") {
      setSelection([hit.id]);
      startMove(p, [hit.id], hit.id, false);
      return;
    }
    if (hit) {
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      let next = sel;
      if (additive) next = sel.includes(hit.id) ? sel : [...sel, hit.id];
      else if (!sel.includes(hit.id)) next = [hit.id];
      setSelection(next);
      startMove(p, next, hit.id, additive && sel.includes(hit.id));
      return;
    }
    setDrag({ kind: "marquee", start: p, cur: p, base: e.shiftKey ? sel : [] });
    if (!e.shiftKey) setSelection([]);
  };

  const eraseAt = (p: Pt) => {
    const dg = dragRef.current;
    if (dg?.kind !== "erase") return;
    const { doc: d, view: v } = live.current;
    for (const o of Object.values(d.objects)) {
      if (o.type === "pen" && !dg.erased.has(o.id) && penHit(o, p, 6 / v.zoom)) {
        dg.erased.add(o.id);
        dg.g.apply([{ k: "del", id: o.id }]);
      }
    }
  };

  /** The object a connector would attach to at `p`, given what's happening. */
  const snapTargetAt = (p: Pt, dg: Drag | null): string | null => {
    const d = live.current.doc;
    if (dg?.kind === "connect") return attachTarget(sortedRef.current, p, dg.from.id)?.id ?? null;
    if (dg?.kind === "endpoint") {
      const c = d.objects[dg.id] as Connector | undefined;
      const far = c?.[dg.which === "from" ? "to" : "from"]?.id;
      return attachTarget(sortedRef.current, p, far)?.id ?? null;
    }
    // Hovering with the connector tool: show what a line would start from.
    if (!dg && live.current.tool === "connector") return attachTarget(sortedRef.current, p)?.id ?? null;
    return null;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = worldPt(e);
    onPointerWorld(p);
    sync.presence({ cursor: p });
    const dg = dragRef.current;
    const target = snapTargetAt(p, dg);
    setSnap(target);
    const over = target ? live.current.doc.objects[target] : null;
    const landing = over && nearBorder(over, p) ? nearestAnchor(over, p) : null;
    setAnchorDot(landing ? { x: over!.x + landing.x * over!.w, y: over!.y + landing.y * over!.h } : null);
    if (!dg) return;
    const d = live.current.doc;
    switch (dg.kind) {
      case "pan": {
        const { sx, sy } = screenPt(e);
        setView({ ...dg.view, tx: dg.view.tx + sx - dg.sx, ty: dg.view.ty + sy - dg.sy });
        return;
      }
      case "marquee": {
        const r = normRect(dg.start, p);
        const ids = sortedRef.current
          .filter((o) => {
            const b = bounds(d, o);
            // Sections only when fully inside, so a marquee within one picks its contents.
            return o.type === "section" ? contains(r, b) : intersects(r, b);
          })
          .map((o) => o.id);
        setSelection([...new Set([...dg.base, ...ids])]);
        setDrag({ ...dg, cur: p });
        return;
      }
      case "move": {
        const dx = p.x - dg.start.x;
        const dy = p.y - dg.start.y;
        if (!dg.moved && Math.hypot(dx, dy) * live.current.view.zoom < 3) return;
        const ops = [];
        for (const [id, o] of dg.origins) {
          if (o.from && o.to) {
            const set: Record<string, unknown> = {};
            if (!o.from.id) set.from = { x: o.from.x + dx, y: o.from.y + dy };
            if (!o.to.id) set.to = { x: o.to.x + dx, y: o.to.y + dy };
            if (Object.keys(set).length) ops.push({ k: "patch" as const, id, set });
          } else {
            ops.push({ k: "patch" as const, id, set: { x: Math.round(o.x + dx), y: Math.round(o.y + dy) } });
          }
        }
        dg.g.apply(ops);
        if (!dg.moved) setDrag({ ...dg, moved: true });
        return;
      }
      case "resize": {
        const { rect: r, handle } = dg;
        const dx = p.x - dg.start.x;
        const dy = p.y - dg.start.y;
        let x1 = r.x;
        let y1 = r.y;
        let x2 = r.x + r.w;
        let y2 = r.y + r.h;
        if (handle.includes("w")) x1 += dx;
        else x2 += dx;
        if (handle.includes("n")) y1 += dy;
        else y2 += dy;
        let w = Math.max(20, Math.abs(x2 - x1));
        let h = Math.max(20, Math.abs(y2 - y1));
        if (dg.keepRatio !== e.shiftKey) {
          const ratio = r.w / r.h;
          if (w / h > ratio) h = w / ratio;
          else w = h * ratio;
        }
        const x = handle.includes("w") ? r.x + r.w - w : r.x;
        const y = handle.includes("n") ? r.y + r.h - h : r.y;
        dg.g.apply([{ k: "patch", id: dg.id, set: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) } }]);
        return;
      }
      case "create": {
        const r = normRect(dg.start, p);
        dg.g.apply([{ k: "patch", id: dg.id, set: { x: Math.round(r.x), y: Math.round(r.y), w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)) } }]);
        return;
      }
      case "connect":
        setDrag({ ...dg, cur: p });
        return;
      case "endpoint": {
        const target = attachTarget(sortedRef.current, p, (d.objects[dg.id] as Connector | undefined)?.[dg.which === "from" ? "to" : "from"]?.id);
        const end: ConnectorEnd = target ? { id: target.id, x: p.x, y: p.y, at: anchorAt(target, p) } : { x: p.x, y: p.y };
        dg.g.apply([{ k: "patch", id: dg.id, set: { [dg.which]: end } }]);
        return;
      }
      case "pen":
        setDrag({ ...dg, points: [...dg.points, [p.x, p.y]] });
        return;
      case "erase":
        eraseAt(p);
        return;
      case "bend": {
        const c = d.objects[dg.id];
        if (c?.type !== "connector") return;
        const { a, b } = connectorCurve(d, c);
        dg.g.apply([
          {
            k: "patch",
            id: dg.id,
            set: { bend: { x: Math.round(p.x - (a.x + b.x) / 2), y: Math.round(p.y - (a.y + b.y) / 2) } },
          },
        ]);
        return;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const dg = dragRef.current;
    setDrag(null);
    setSnap(null);
    setAnchorDot(null);
    if (!dg) return;
    const d = live.current.doc;
    const p = worldPt(e);
    switch (dg.kind) {
      case "move":
        dg.g.end();
        // A click (no drag) on an already-selected item in a multi-selection
        // with shift takes it out; a plain click narrows to it.
        if (!dg.moved) {
          const sel = live.current.selection;
          if (dg.additive) setSelection(sel.filter((id) => id !== dg.clickId));
          else if (sel.length > 1 && !(e.shiftKey || e.metaKey || e.ctrlKey)) setSelection([dg.clickId]);
          const o = d.objects[dg.clickId];
          if (o?.type === "comment") onOpenComment({ id: o.id });
        }
        return;
      case "resize":
        dg.g.end();
        return;
      case "create": {
        const o = d.objects[dg.id];
        if (o && (o.w < 8 || o.h < 8)) {
          // A click, not a drag: default size centred on the click.
          const s = DEFAULT_SIZES[dg.type];
          dg.g.apply([{ k: "patch", id: dg.id, set: { x: Math.round(dg.start.x - s.w / 2), y: Math.round(dg.start.y - s.h / 2), w: s.w, h: s.h } }]);
        }
        dg.g.end();
        setTool("select");
        if (dg.type === "section") setEditing(dg.id);
        return;
      }
      case "connect": {
        const target = attachTarget(sortedRef.current, p, dg.from.id);
        const to: ConnectorEnd = target ? { id: target.id, x: p.x, y: p.y, at: anchorAt(target, p) } : { x: p.x, y: p.y };
        const len = Math.hypot(p.x - dg.from.x, p.y - dg.from.y);
        if (len * live.current.view.zoom > 8 || (target && dg.from.id)) {
          const id = create({ type: "connector", from: dg.from, to, label: "", arrow: "end", color: INKS.black } as Partial<Connector> & { type: "connector" });
          setSelection([id]);
        }
        return;
      }
      case "endpoint":
      case "bend":
        dg.g.end();
        return;
      case "pen": {
        const opts = live.current.toolOptions;
        const pts = simplify(dg.points, 1.5 / live.current.view.zoom);
        const xs = pts.map((q) => q[0]);
        const ys = pts.map((q) => q[1]);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        create({
          type: "pen",
          x,
          y,
          w: Math.max(1, Math.max(...xs) - x),
          h: Math.max(1, Math.max(...ys) - y),
          points: pts.map(([px, py]) => [px - x, py - y]),
          color: opts.penColor,
          width: opts.penWidth,
        } as Partial<BoardObject> & { type: "pen" });
        return;
      }
      case "erase":
        dg.g.end();
        return;
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (readOnly) return;
    const { doc: d, view: v } = live.current;
    const p = worldPt(e);
    const hit = hitTest(d, sortedRef.current, p, v.zoom);
    if (!hit) {
      // Double-click on empty board: a sticky, like FigJam's quick add.
      if (live.current.tool !== "select") return;
      const s = DEFAULT_SIZES.sticky;
      const id = create({ type: "sticky", x: p.x - s.w / 2, y: p.y - s.h / 2, w: s.w, h: s.h, color: live.current.toolOptions.stickyColor, text: "" });
      setSelection([id]);
      setEditing(id);
      return;
    }
    if (hit.type === "table") {
      // Ask the page which cell is under the pointer rather than working it out
      // from the box: rows take the height their content needs, so dividing the
      // box evenly lands on the wrong one.
      const td = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("td[data-cell]");
      const [r, c] = (td?.dataset.cell ?? "0,0").split(",").map(Number);
      setSelection([hit.id]);
      setCell({ id: hit.id, r: Math.min(r, hit.rows.length - 1), c: Math.min(c, hit.rows[0].length - 1) });
      return;
    }
    if (hit.type === "sticky" || hit.type === "text" || hit.type === "shape" || hit.type === "section") {
      setSelection([hit.id]);
      setEditing(hit.id);
    } else if (hit.type === "connector") {
      const label = window.prompt("Connector label", hit.label);
      if (label !== null) sync.apply([{ k: "patch", id: hit.id, set: { label } }]);
    }
  };

  const onPointerLeave = () => {
    setSnap(null);
    onPointerWorld(null);
    sync.presence({ cursor: null });
  };

  // ---------------------------------------------------------- drop images
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (readOnly) return;
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
    if (files.length) onDropFiles(files, worldPt(e));
  };

  // ---------------------------------------------------------- render
  const selected = new Set(selection);
  const remoteSel = new Map<string, Peer>();
  const remoteEditing = new Map<string, string>();
  for (const peer of Object.values(peers)) {
    for (const id of peer.selection ?? []) remoteSel.set(id, peer);
    if (peer.editing) remoteEditing.set(peer.editing, peer.user.color);
  }

  const cursorClass =
    space || tool === "hand" || readOnly
      ? drag?.kind === "pan"
        ? "cursor-grabbing"
        : "cursor-grab"
      : tool === "select"
        ? "cursor-default"
        : "cursor-crosshair";

  // The ends a connector is (or would be) attached to: the fixed end plus
  // whatever is under the pointer. Deriving it here means a stale snap target
  // can't outlive the tool or the drag that produced it.
  const highlighted = new Set<string>();
  if (drag?.kind === "connect") {
    if (drag.from.id) highlighted.add(drag.from.id);
    if (snap) highlighted.add(snap);
  } else if (drag?.kind === "endpoint") {
    const c = doc.objects[drag.id] as Connector | undefined;
    const far = c?.[drag.which === "from" ? "to" : "from"]?.id;
    if (far) highlighted.add(far);
    if (snap) highlighted.add(snap);
  } else if (tool === "connector" && snap) {
    highlighted.add(snap);
  }

  const z = view.zoom;
  const single = selection.length === 1 ? doc.objects[selection[0]] : null;
  const selBounds = unionRect(selection.map((id) => doc.objects[id]).filter(Boolean).map((o) => bounds(doc, o)));

  return (
    <div
      ref={rootRef}
      className={cn("absolute inset-0 touch-none overflow-hidden bg-zinc-50 dark:bg-zinc-900", cursorClass)}
      style={{
        backgroundImage: "radial-gradient(circle, rgb(161 161 170 / 0.45) 1px, transparent 1px)",
        backgroundSize: `${24 * z}px ${24 * z}px`,
        backgroundPosition: `${view.tx}px ${view.ty}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      data-testid="board-canvas"
    >
      {/* World layer */}
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${z})` }}
      >
        {sorted.map((o) =>
          o.type === "connector" ? (
            <ConnectorView key={o.id} doc={doc} o={o} />
          ) : (
            <ObjectView
              key={o.id}
              o={o}
              editing={editing === o.id}
              me={me}
              handlers={handlers}
              hiddenCount={foldedCounts.get(o.id)}
              selected={selected.has(o.id)}
              cell={cell?.id === o.id ? cell : null}
              lockedBy={remoteEditing.get(o.id)}
            />
          ),
        )}

        {/* Remote selections */}
        {[...remoteSel].map(([id, peer]) => {
          const o = doc.objects[id];
          if (!o || selected.has(id)) return null;
          const b = bounds(doc, o);
          return (
            <div
              key={`rs-${peer.pid}-${id}`}
              className="pointer-events-none absolute"
              style={{
                left: b.x - 3 / z,
                top: b.y - 3 / z,
                width: b.w + 6 / z,
                height: b.h + 6 / z,
                border: `${2 / z}px solid ${peer.user.color}`,
                borderRadius: 4 / z,
                zIndex: 1e9,
              }}
            >
              <span
                className="absolute left-0 whitespace-nowrap rounded px-1 font-medium text-white"
                style={{ background: peer.user.color, fontSize: 11 / z, top: -18 / z, padding: `${1 / z}px ${4 / z}px` }}
              >
                {peer.user.name}
              </span>
            </div>
          );
        })}

        {/* My selection */}
        {selBounds && !editing && (
          <div
            className="pointer-events-none absolute"
            style={{
              left: selBounds.x - 4 / z,
              top: selBounds.y - 4 / z,
              width: selBounds.w + 8 / z,
              height: selBounds.h + 8 / z,
              border: `${1.5 / z}px solid #3b82f6`,
              borderRadius: 3 / z,
              zIndex: 1e9,
            }}
          />
        )}
        {single && !editing && single.type !== "comment" && single.type !== "pen" && single.type !== "connector" &&
          (
            [
              [single.x, single.y],
              [single.x + single.w, single.y],
              [single.x, single.y + single.h],
              [single.x + single.w, single.y + single.h],
            ] as const
          ).map(([hx, hy], i) => (
            <div
              key={i}
              className="pointer-events-none absolute rounded-sm border-blue-500 bg-white"
              style={{
                left: hx - HANDLE_PX / 2 / z,
                top: hy - HANDLE_PX / 2 / z,
                width: HANDLE_PX / z,
                height: HANDLE_PX / z,
                borderWidth: 1.5 / z,
                zIndex: 1e9,
              }}
            />
          ))}
        {single?.type === "connector" &&
          (() => {
            const { a, b, mid } = connectorCurve(doc, single);
            const handles = single.straight ? [a, b] : [a, b, mid];
            return handles.map((q, i) => (
              <div
                key={i}
                className="pointer-events-none absolute rounded-full border-blue-500 bg-white"
                style={{
                  left: q.x - HANDLE_PX / 2 / z,
                  top: q.y - HANDLE_PX / 2 / z,
                  width: HANDLE_PX / z,
                  height: HANDLE_PX / z,
                  borderWidth: 2 / z,
                  zIndex: 1e9,
                }}
              />
            ));
          })()}

        {/* What a connector is about to attach to */}
        {[...highlighted].map((id) => {
          const o = doc.objects[id];
          if (!o) return null;
          const b = bounds(doc, o);
          return (
            <div
              key={`snap-${id}`}
              className="pointer-events-none absolute bg-blue-500/10"
              style={{
                left: b.x - 4 / z,
                top: b.y - 4 / z,
                width: b.w + 8 / z,
                height: b.h + 8 / z,
                border: `${2.5 / z}px solid #3b82f6`,
                borderRadius: o.type === "comment" ? "9999px" : 6 / z,
                zIndex: 1e9 - 2,
              }}
            />
          );
        })}

        {/* Exactly where this end would land on the thing it's meeting */}
        {(drag?.kind === "connect" || drag?.kind === "endpoint") && anchorDot && (
          <div
            className="pointer-events-none absolute rounded-full border-white bg-blue-500"
            style={{
              left: anchorDot.x - 6 / z,
              top: anchorDot.y - 6 / z,
              width: 12 / z,
              height: 12 / z,
              borderWidth: 2 / z,
              zIndex: 1e9,
            }}
          />
        )}

        {/* In-progress drawing */}
        {drag?.kind === "pen" && (
          <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1} style={{ zIndex: 1e9 }}>
            <path
              d={penPath(drag.points)}
              fill="none"
              stroke={toolOptions.penColor}
              strokeWidth={toolOptions.penWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
        {drag?.kind === "connect" && (
          <ConnectorView
            preview
            doc={doc}
            o={{
              id: "preview",
              type: "connector",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              z: 1e9,
              createdAt: 0,
              from: drag.from,
              to: (() => {
                const t = attachTarget(sorted, drag.cur, drag.from.id);
                return t ? { id: t.id, x: 0, y: 0 } : drag.cur;
              })(),
              label: "",
              arrow: "end",
              color: "#3b82f6",
            }}
          />
        )}
      </div>

      {/* Screen layer: marquee, cursors, reactions */}
      {drag?.kind === "marquee" &&
        (() => {
          const r = normRect(drag.start, drag.cur);
          return (
            <div
              className="pointer-events-none absolute border border-blue-500 bg-blue-500/10"
              style={{ left: r.x * z + view.tx, top: r.y * z + view.ty, width: r.w * z, height: r.h * z }}
            />
          );
        })()}

      {Object.values(peers).map((peer) => {
        if (!peer.cursor) return null;
        const at = { x: peer.cursor.x * z + view.tx, y: peer.cursor.y * z + view.ty };

        // Working somewhere you can't see: a marker on the edge of the view,
        // pointing their way. Click it to go to them.
        if (offScreen(area.w, area.h, at, insets)) {
          const e = edgePoint(area.w, area.h, at, insets);
          return (
            <button
              key={peer.pid}
              className="absolute z-30 flex size-7 items-center justify-center rounded-full text-[11px] font-semibold text-white shadow-md ring-2 ring-background transition-transform hover:scale-110"
              style={{ left: e.x, top: e.y, transform: "translate(-50%, -50%)", background: peer.user.color }}
              title={`${peer.user.name} is working over here${peer.note ? ` · ${peer.note}` : ""} — click to follow`}
              onClick={() => onFollowPeer(peer.pid)}
            >
              {peer.kind === "human" ? initials(peer.user.name) : "AI"}
              <span
                className="pointer-events-none absolute left-1/2 top-1/2 size-0 border-y-[5px] border-l-[7px] border-y-transparent"
                style={{ borderLeftColor: peer.user.color, transform: `rotate(${e.angle}rad) translateX(18px) translateY(-5px)` }}
              />
            </button>
          );
        }

        return (
          <div
            key={peer.pid}
            className="pointer-events-none absolute left-0 top-0 transition-transform duration-75 ease-linear"
            style={{
              transform: `translate(${at.x}px, ${at.y}px)`,
              zIndex: 30,
              transitionDuration: peer.kind === "human" ? "60ms" : "260ms",
            }}
          >
            <svg width="18" height="20" viewBox="0 0 18 20" className="drop-shadow">
              <path d="M1 1 L1 16 L5.5 12 L8.5 19 L11 18 L8 11 L14 11 Z" fill={peer.user.color} stroke="white" strokeWidth="1.5" />
            </svg>
            <div
              className="ml-3 -mt-1 flex max-w-[22rem] items-center gap-1 truncate rounded-full px-2 py-0.5 text-xs font-medium text-white shadow"
              style={{ background: peer.user.color }}
            >
              {peer.user.name}
              {peer.kind !== "human" && peer.status === "thinking" && (
                <span className="animate-pulse truncate">· {peer.note || "thinking…"}</span>
              )}
            </div>
          </div>
        );
      })}

      {reactions.map((r) => (
        <div
          key={r.key}
          className="board-reaction pointer-events-none absolute text-3xl"
          style={{ left: r.at.x * z + view.tx, top: r.at.y * z + view.ty, zIndex: 31 }}
        >
          {r.emoji}
        </div>
      ))}

      <style>{`
        @keyframes board-float { 0% { transform: translate(-50%, -50%) scale(.6); opacity: 0 } 15% { transform: translate(-50%, -80%) scale(1.15); opacity: 1 } 100% { transform: translate(-50%, -260%) scale(1); opacity: 0 } }
        .board-reaction { animation: board-float 2.1s ease-out forwards; }
      `}</style>

      {/* Own cursor colour hint for the pen */}
      <span className="sr-only" style={{ color: myColor }} />
    </div>
  );
}

export function isTyping(e: KeyboardEvent | React.KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

/** Copies of `objs` with new ids, offset, connectors between them re-pointed. */
export function cloneObjects(doc: BoardDoc, objs: BoardObject[], dx: number, dy: number): BoardObject[] {
  const ids = new Map(objs.map((o) => [o.id, newId(o.type[0])]));
  let z = maxZ(doc);
  return objs
    .sort((a, b) => a.z - b.z)
    .map((o) => {
      const id = ids.get(o.id)!;
      // A copy starts fresh: no votes, not a suggestion, authored by whoever pastes.
      const rest: Record<string, unknown> = { ...o };
      delete rest.votes;
      delete rest.suggestion;
      delete rest.author;
      const c = { ...rest, id, x: o.x + dx, y: o.y + dy, z: o.type === "section" ? o.z : ++z } as BoardObject;
      if (c.type === "connector" && o.type === "connector") {
        // Ends on copied objects follow the copies; ends on objects left behind
        // stay attached to them; free ends move with the copy.
        const end = (e: ConnectorEnd): ConnectorEnd => {
          if (e.id && ids.has(e.id)) return { ...e, id: ids.get(e.id)! };
          if (e.id && doc.objects[e.id]) return e;
          return { x: e.x + dx, y: e.y + dy };
        };
        c.from = end(o.from);
        c.to = end(o.to);
      }
      return c;
    });
}
