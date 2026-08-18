"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import {
  ALargeSmall,
  Check,
  ChevronLeft,
  Minus,
  Palette,
  Pencil,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { useSubject } from "subjecto/react";

import { AnsiText } from "@/components/ansi-text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { BASE_PATH } from "@/lib/config";
import { useIsMobile } from "@/lib/use-is-mobile";
import {
  closeTerminal,
  dock,
  hydrateDock,
  minimizeTerminal,
  openTerminal,
  reconcileTerminals,
  renameTerminal,
  restoreTerminal,
  setLiveTerminals,
  setTerminalStatus,
  termStatus,
  type TermStatus,
} from "@/store/terminals";

const API = `${BASE_PATH}/api/terminals`;
const POLL_MS = 1000;
// Approximate monospace metrics for text-xs / leading-relaxed, used to map a
// window's pixel size onto tmux columns/rows.
const CHAR_W = 7.2;
const LINE_H = 19.5;

// The standard + bright 16-colour ANSI palette, offered for the window bars.
const PALETTE: { name: string; value: string }[] = [
  { name: "Black", value: "#000000" },
  { name: "Red", value: "#cd3131" },
  { name: "Green", value: "#0dbc79" },
  { name: "Yellow", value: "#e5e510" },
  { name: "Blue", value: "#2472c8" },
  { name: "Magenta", value: "#bc3fbc" },
  { name: "Cyan", value: "#11a8cd" },
  { name: "White", value: "#e5e5e5" },
  { name: "Bright Black", value: "#666666" },
  { name: "Bright Red", value: "#f14c4c" },
  { name: "Bright Green", value: "#23d18b" },
  { name: "Bright Yellow", value: "#f5f543" },
  { name: "Bright Blue", value: "#3b8eea" },
  { name: "Bright Magenta", value: "#d670d6" },
  { name: "Bright Cyan", value: "#29b8db" },
  { name: "Bright White", value: "#ffffff" },
];

function styleKey(name: string) {
  return `admin-term-style:${name}`;
}
/** One colour applies to both the top and bottom bars of a window. */
function loadBarColor(name: string): string | null {
  try {
    const raw = localStorage.getItem(styleKey(name));
    if (!raw) return null;
    // Back-compat: earlier versions stored { top, bottom }.
    if (raw.startsWith("{")) {
      const s = JSON.parse(raw);
      return s.color ?? s.top ?? s.bottom ?? null;
    }
    return raw;
  } catch {
    return null;
  }
}
function saveBarColor(name: string, color: string | null) {
  try {
    if (color) localStorage.setItem(styleKey(name), color);
    else localStorage.removeItem(styleKey(name));
  } catch {
    /* ignore */
  }
}
// Three terminal font sizes, cycled by the header button. The Tailwind classes
// drive BOTH the pane and the hidden metrics probe, so the pixels→cols/rows math
// (and the tmux reshape) stays exact at any size.
const FONT_SIZES = [
  { cls: "text-xs", label: "Small" },
  { cls: "text-sm", label: "Medium" },
  { cls: "text-base", label: "Large" },
] as const;
type FontSizeCls = (typeof FONT_SIZES)[number]["cls"];
const DEFAULT_FONT: FontSizeCls = "text-xs";

function fontKey(name: string) {
  return `admin-term-font:${name}`;
}
function loadFontSize(name: string): FontSizeCls {
  try {
    const raw = localStorage.getItem(fontKey(name));
    if (raw && FONT_SIZES.some((f) => f.cls === raw)) return raw as FontSizeCls;
  } catch {
    /* ignore */
  }
  return DEFAULT_FONT;
}
function saveFontSize(name: string, cls: FontSizeCls) {
  try {
    localStorage.setItem(fontKey(name), cls);
  } catch {
    /* ignore */
  }
}
function fontLabel(cls: FontSizeCls): string {
  return FONT_SIZES.find((f) => f.cls === cls)?.label ?? "Small";
}
function nextFontSize(cls: FontSizeCls): FontSizeCls {
  const i = FONT_SIZES.findIndex((f) => f.cls === cls);
  return FONT_SIZES[(i + 1) % FONT_SIZES.length].cls;
}

/** Readable text colour (black/white) for a given background hex. */
function textOn(bg: string): string {
  const c = bg.replace("#", "");
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.55 ? "#000000" : "#ffffff";
}

/* ---- network helpers shared by the dock and the management panel ---- */

/** Kill the tmux session and drop its window. Returns success. */
export async function killSession(name: string): Promise<boolean> {
  try {
    const res = await fetch(`${API}?name=${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "failed to kill");
    closeTerminal(name);
    toast.success(`Killed "${name}"`);
    return true;
  } catch (e) {
    toast.error((e as Error).message);
    return false;
  }
}

/** Rename the tmux session, carrying window/dock state to the new name. */
async function renameSession(oldName: string, next: string): Promise<boolean> {
  const to = next.trim();
  if (!to || to === oldName) return false;
  try {
    const res = await fetch(`${API}/${encodeURIComponent(oldName)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: to }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "failed to rename");
    saveBarColor(to, loadBarColor(oldName)); // carry bar colour over
    renameTerminal(oldName, to);
    toast.success(`Renamed to "${to}"`);
    return true;
  } catch (e) {
    toast.error((e as Error).message);
    return false;
  }
}

/* ------------------------------ the dock -------------------------------- */

/**
 * Renders every open terminal as a floating window plus a bottom bar of the
 * minimized ones. Mounted once in the root layout so windows persist across
 * route changes and page reloads. State lives in the `@/store/terminals`
 * subject; this component only paints it.
 */
export function TerminalDock() {
  const pathname = usePathname();
  const [{ open, minimized }] = useSubject(dock);
  const [statuses] = useSubject(termStatus);
  const isMobile = useIsMobile();
  const zTop = useRef(10);
  const bringToFront = useCallback(() => ++zTop.current, []);

  // Restore persisted membership once, after mount.
  useEffect(() => {
    hydrateDock();
  }, []);

  // Poll the live session list to drop windows whose tmux session vanished
  // (e.g. killed from another tab or the CLI).
  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const res = await fetch(API, { cache: "no-store" });
        const json = await res.json();
        if (active && res.ok) {
          const list: { name: string; status?: TermStatus }[] =
            json.terminals ?? [];
          reconcileTerminals(list.map((t) => t.name));
          for (const t of list) {
            if (t.status) setTerminalStatus(t.name, t.status);
          }
          setLiveTerminals(
            list.map((t) => ({ name: t.name, status: t.status ?? "idle" })),
          );
        }
      } catch {
        /* transient */
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  // The login screen renders without app chrome.
  if (pathname === "/login") return null;

  // Mobile: floating draggable windows don't work on a phone. Show the frontmost
  // open terminal as a full-screen sheet; other open terminals are switchable
  // tabs. (The desktop dock/minimize bar is hidden below md.)
  if (isMobile) {
    const visible = open.filter((n) => !minimized.includes(n));
    const active = visible[visible.length - 1];
    if (!active) return null;
    return (
      <MobileTerminalSheet
        key={active}
        name={active}
        openNames={visible}
        onClose={() => closeTerminal(active)}
        onKill={() => {
          if (confirm(`Kill terminal "${active}"? Running processes will stop.`))
            void killSession(active);
        }}
        onRename={(next) => renameSession(active, next)}
      />
    );
  }

  return (
    <>
      {open.map((name, i) => (
        <TerminalWindow
          key={name}
          name={name}
          index={i}
          minimized={minimized.includes(name)}
          bringToFront={bringToFront}
          onMinimize={() => minimizeTerminal(name)}
          onClose={() => closeTerminal(name)}
          onKill={() => {
            if (
              confirm(`Kill terminal "${name}"? Running processes will stop.`)
            )
              void killSession(name);
          }}
          onRename={(next) => renameSession(name, next)}
        />
      ))}

      {minimized.length > 0 && (
        <div className="fixed bottom-3 left-1/2 z-[60] flex max-w-[92vw] -translate-x-1/2 flex-wrap items-center gap-1.5 rounded-full border bg-background/95 px-2 py-1.5 shadow-2xl ring-1 ring-foreground/10 backdrop-blur">
          <span className="px-1 text-xs text-muted-foreground">Minimized</span>
          {minimized.map((name) => (
            <span
              key={name}
              className="flex items-center gap-1 rounded-full border bg-muted/60 py-0.5 pr-0.5 pl-2 text-xs"
            >
              <button
                type="button"
                onClick={() => restoreTerminal(name)}
                title={`Restore ${name} — ${statusLabel(statuses[name] ?? "idle")}`}
                className="flex items-center gap-1.5 font-medium hover:underline"
              >
                <TermStatusDot status={statuses[name] ?? "idle"} />
                <span className="max-w-[10rem] truncate">{name}</span>
              </button>
              <button
                type="button"
                onClick={() => closeTerminal(name)}
                aria-label={`Close ${name}`}
                title="Close window (session keeps running)"
                className="rounded-full p-0.5 opacity-60 hover:bg-foreground/10 hover:opacity-100"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/* --------------------------- floating window ---------------------------- */

function TerminalWindow({
  name,
  index,
  minimized,
  bringToFront,
  onMinimize,
  onClose,
  onKill,
  onRename,
}: {
  name: string;
  index: number;
  minimized: boolean;
  bringToFront: () => number;
  onMinimize: () => void;
  onClose: () => void;
  onKill: () => void;
  onRename: (next: string) => Promise<boolean>;
}) {
  const [pos, setPos] = useState(() => ({
    x: 120 + index * 32,
    y: 90 + index * 32,
  }));
  const [z, setZ] = useState(() => bringToFront());
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [color, setColor] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState<FontSizeCls>(DEFAULT_FONT);
  const [status, setStatus] = useState<TermStatus>("idle");
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  // Load persisted per-terminal prefs (client-only; localStorage is unavailable
  // during SSR, so this must run after mount).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setColor(loadBarColor(name));
    setFontSize(loadFontSize(name));
  }, [name]);

  function pickColor(next: string | null) {
    setColor(next);
    saveBarColor(name, next);
  }

  function cycleFontSize() {
    const next = nextFontSize(fontSize);
    setFontSize(next);
    saveFontSize(name, next);
  }

  function onHeaderPointerDown(e: React.PointerEvent) {
    // Ignore drags that start on a control (buttons, the rename input).
    if ((e.target as HTMLElement).closest("button, input")) return;
    setZ(bringToFront());
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    const move = (ev: PointerEvent) => {
      if (!drag.current) return;
      setPos({
        x: Math.max(0, ev.clientX - drag.current.dx),
        y: Math.max(0, ev.clientY - drag.current.dy),
      });
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  async function submitRename(e: React.FormEvent) {
    e.preventDefault();
    const ok = await onRename(draft);
    if (ok) setRenaming(false);
  }

  // One colour drives both bars; text/icons switch to black or white for
  // contrast, and the button hover tint adapts to the bar's lightness.
  const barStyle = color
    ? { backgroundColor: color, color: textOn(color) }
    : undefined;
  const onDark = color ? textOn(color) === "#ffffff" : false;
  const iconBtn = `rounded p-1 opacity-70 hover:opacity-100 ${
    color ? (onDark ? "hover:bg-white/20" : "hover:bg-black/10") : "hover:bg-muted"
  }`;

  return (
    <div
      role="dialog"
      aria-label={`Terminal ${name}`}
      onPointerDown={() => setZ(bringToFront())}
      style={{ left: pos.x, top: pos.y, zIndex: z }}
      // Kept mounted while minimized (hidden) so its position, size and live
      // output survive a minimize → restore round-trip.
      className={`fixed flex h-[26rem] max-h-[90vh] min-h-[12rem] w-[44rem] max-w-[92vw] min-w-[20rem] resize flex-col overflow-hidden rounded-lg border bg-background shadow-2xl ring-1 ring-foreground/10 ${
        minimized ? "hidden" : ""
      }`}
    >
      <div
        onPointerDown={onHeaderPointerDown}
        style={barStyle}
        className={`flex cursor-move items-center gap-1.5 border-b px-2.5 py-1.5 select-none ${
          color ? "" : "bg-muted/60"
        }`}
      >
        <TerminalSquare className="size-4 shrink-0 opacity-70" />
        <TermStatusDot status={status} />
        {renaming ? (
          <form onSubmit={submitRename} className="flex flex-1 items-center gap-1">
            <Input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setRenaming(false)}
              className="h-6 bg-background py-0 text-sm text-foreground"
              aria-label="Rename terminal"
            />
            <button type="submit" aria-label="Save name" className={iconBtn}>
              <Check className="size-4" />
            </button>
          </form>
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-sm font-medium"
            onDoubleClick={() => {
              setDraft(name);
              setRenaming(true);
            }}
            title="Double-click to rename"
          >
            {name}
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            setDraft(name);
            setRenaming((v) => !v);
          }}
          aria-label="Rename"
          title="Rename terminal"
          className={iconBtn}
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={cycleFontSize}
          aria-label="Font size"
          title={`Font size: ${fontLabel(fontSize)} — click to cycle`}
          className={iconBtn}
        >
          <ALargeSmall className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => setPaletteOpen((v) => !v)}
          aria-label="Window colour"
          title="Window colour"
          className={iconBtn}
        >
          <Palette className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onKill}
          aria-label={`Kill ${name}`}
          title="Kill session"
          className={iconBtn}
        >
          <Trash2 className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onMinimize}
          aria-label="Minimize window"
          title="Minimize to the bottom bar"
          className={iconBtn}
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close window"
          title="Close window (session keeps running)"
          className={iconBtn}
        >
          <X className="size-4" />
        </button>
      </div>

      {paletteOpen && (
        <div className="absolute top-10 right-2 z-10 w-60 rounded-md border bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
          <BarPalette label="Window colour" value={color} onPick={pickColor} />
        </div>
      )}

      <TerminalView
        name={name}
        footerBg={color}
        fontSize={fontSize}
        minimized={minimized}
        onStatus={(s) => {
          setStatus(s);
          setTerminalStatus(name, s);
        }}
      />
    </div>
  );
}

/* --------------------------- mobile full-screen ------------------------- */

/**
 * Tracks the visual viewport height so the sheet shrinks when the soft keyboard
 * opens — keeping the prompt visible above it instead of hidden behind it.
 */
function useViewportHeight(): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    const update = () => setH(vv ? vv.height : window.innerHeight);
    update();
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return h;
}

/**
 * Full-screen terminal for mobile. Replaces the floating window (which can't fit
 * or be dragged on a phone): a top bar with back/rename/font/kill, a tab strip
 * to switch between open terminals, and the shared {@link TerminalView} in
 * `mobile` mode (hidden-textarea keyboard + on-screen control keys).
 */
function MobileTerminalSheet({
  name,
  openNames,
  onClose,
  onKill,
  onRename,
}: {
  name: string;
  openNames: string[];
  onClose: () => void;
  onKill: () => void;
  onRename: (next: string) => Promise<boolean>;
}) {
  const [status, setStatus] = useState<TermStatus>("idle");
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  // Default one size up on mobile for legibility; honour an explicit saved pref.
  const [fontSize, setFontSize] = useState<FontSizeCls>("text-sm");
  const vh = useViewportHeight();

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(fontKey(name));
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFontSize(
      saved && FONT_SIZES.some((f) => f.cls === saved)
        ? (saved as FontSizeCls)
        : "text-sm",
    );
  }, [name]);

  function cycleFontSize() {
    const next = nextFontSize(fontSize);
    setFontSize(next);
    saveFontSize(name, next);
  }

  async function submitRename(e: React.FormEvent) {
    e.preventDefault();
    const ok = await onRename(draft);
    if (ok) setRenaming(false);
  }

  const iconBtn =
    "shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

  return (
    <div
      role="dialog"
      aria-label={`Terminal ${name}`}
      className="fixed inset-x-0 top-0 z-[70] flex flex-col overflow-hidden bg-background md:hidden"
      style={{ height: vh ? `${vh}px` : "100dvh" }}
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        <button onClick={onClose} aria-label="Back to terminals" className={iconBtn}>
          <ChevronLeft className="size-5" />
        </button>
        <TermStatusDot status={status} />
        {renaming ? (
          <form onSubmit={submitRename} className="flex flex-1 items-center gap-1">
            <Input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setRenaming(false)}
              className="h-7 py-0 text-sm"
              aria-label="Rename terminal"
            />
            <button type="submit" aria-label="Save name" className={iconBtn}>
              <Check className="size-4" />
            </button>
          </form>
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-sm font-medium"
            onDoubleClick={() => {
              setDraft(name);
              setRenaming(true);
            }}
          >
            {name}
          </span>
        )}
        <button
          onClick={cycleFontSize}
          aria-label="Font size"
          title={`Font size: ${fontLabel(fontSize)}`}
          className={iconBtn}
        >
          <ALargeSmall className="size-5" />
        </button>
        <button
          onClick={() => {
            setDraft(name);
            setRenaming((v) => !v);
          }}
          aria-label="Rename"
          className={iconBtn}
        >
          <Pencil className="size-4" />
        </button>
        <button onClick={onKill} aria-label="Kill session" className={iconBtn}>
          <Trash2 className="size-4" />
        </button>
      </div>

      {openNames.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {openNames.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => openTerminal(n)}
              className={`shrink-0 rounded-full px-3 py-1 text-xs ${
                n === name
                  ? "bg-accent font-medium text-accent-foreground"
                  : "bg-muted/60 text-muted-foreground"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      )}

      <TerminalView
        mobile
        name={name}
        fontSize={fontSize}
        onStatus={(s) => {
          setStatus(s);
          setTerminalStatus(name, s);
        }}
      />
    </div>
  );
}

function BarPalette({
  label,
  value,
  onPick,
}: {
  label: string;
  value: string | null;
  onPick: (v: string | null) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        <button
          type="button"
          onClick={() => onPick(null)}
          className={`rounded px-1.5 py-0.5 text-xs ${
            value === null
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground hover:underline"
          }`}
        >
          Default
        </button>
      </div>
      <div className="grid grid-cols-8 gap-1">
        {PALETTE.map((c) => (
          <button
            key={c.value}
            type="button"
            title={c.name}
            aria-label={`${label}: ${c.name}`}
            onClick={() => onPick(c.value)}
            style={{ backgroundColor: c.value, color: textOn(c.value) }}
            className={`flex size-6 items-center justify-center rounded ring-1 ring-black/20 ${
              value === c.value
                ? "outline outline-2 outline-offset-1 outline-ring"
                : ""
            }`}
          >
            {value === c.value && <Check className="size-3.5" />}
          </button>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------- status -------------------------------- */

/** Human-readable description of a terminal status. */
export function statusLabel(status: TermStatus): string {
  switch (status) {
    case "claude-working":
      return "Claude is working";
    case "claude-waiting":
      return "Claude is waiting for input";
    case "busy":
      return "Running a command";
    default:
      return "Idle — at a shell prompt";
  }
}

// dot colour + optional pulse colour, per status. Orange = a Claude session; it
// pulses while Claude is working and is steady while it waits for you. Class
// names are literals so Tailwind picks them up.
const DOT: Record<TermStatus, { dot: string; ping: string | null }> = {
  idle: { dot: "bg-muted-foreground/40", ping: null },
  busy: { dot: "bg-emerald-500", ping: "bg-emerald-400" },
  "claude-working": { dot: "bg-orange-500", ping: "bg-orange-400" },
  "claude-waiting": { dot: "bg-orange-500", ping: null },
};

/**
 * Status indicator dot. Grey = idle at a prompt, green (pulsing) = running a
 * command, orange = a Claude session (pulsing while Claude works, steady while
 * it waits for input).
 */
export function TermStatusDot({ status }: { status: TermStatus }) {
  const { dot, ping } = DOT[status];
  return (
    <StatusDot color={dot} pulse={ping !== null} label={statusLabel(status)} />
  );
}

/* ------------------------------ terminal I/O ---------------------------- */

const CTRL_KEYS: Record<string, string> = {
  c: "C-c",
  d: "C-d",
  z: "C-z",
  l: "C-l",
  a: "C-a",
  e: "C-e",
  u: "C-u",
  k: "C-k",
  r: "C-r",
};

const SPECIAL_KEYS: Record<string, string> = {
  Enter: "Enter",
  Backspace: "BSpace",
  Tab: "Tab",
  Escape: "Escape",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

function TerminalView({
  name,
  footerBg,
  fontSize,
  minimized,
  mobile,
  onStatus,
}: {
  name: string;
  footerBg?: string | null;
  fontSize: FontSizeCls;
  minimized?: boolean;
  mobile?: boolean;
  onStatus?: (status: TermStatus) => void;
}) {
  const [content, setContent] = useState("");
  const [size, setSize] = useState("");
  const [status, setStatus] = useState<TermStatus>("idle");
  const [focused, setFocused] = useState(false);
  const screenRef = useRef<HTMLPreElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const base = `${API}/${encodeURIComponent(name)}`;

  // Keep the latest onStatus without re-creating `refresh` on every render.
  const onStatusRef = useRef(onStatus);
  useEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);

  // Monotonic id for input POSTs. Lets us (a) ignore an out-of-order capture
  // that would rewind fresher content, and (b) have the 1s poll stand down
  // while keystrokes are in flight — their POST responses carry newer captures.
  const seq = useRef(0);
  const inflight = useRef(0);

  const applySnap = useCallback(
    (json: { content?: string; size?: string; status?: TermStatus }) => {
      const s: TermStatus = json.status ?? "idle";
      setContent(json.content ?? "");
      setSize(json.size ?? "");
      setStatus(s);
      onStatusRef.current?.(s);
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (inflight.current > 0) return; // don't clobber in-flight keystrokes
    try {
      const res = await fetch(base, { cache: "no-store" });
      const json = await res.json();
      if (res.ok) applySnap(json);
    } catch {
      /* transient */
    }
  }, [base, applySnap]);

  useEffect(() => {
    let active = true;
    const tick = () => {
      if (active) void refresh();
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [refresh]);

  // Reshape the tmux window to match the on-screen size (debounced) so the
  // captured pane exactly fills the viewport — no wrapping, no scrollbars.
  useEffect(() => {
    const el = screenRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let last = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const metrics = () => {
      const meas = measureRef.current;
      if (meas) {
        const r = meas.getBoundingClientRect();
        // measurer holds 50 chars on line 1 and a 2nd line, so:
        return { charW: r.width / 50 || CHAR_W, lineH: r.height / 2 || LINE_H };
      }
      return { charW: CHAR_W, lineH: LINE_H };
    };

    const compute = () => {
      const cs = getComputedStyle(el);
      const padX =
        parseFloat(cs.paddingLeft || "0") + parseFloat(cs.paddingRight || "0");
      const padY =
        parseFloat(cs.paddingTop || "0") + parseFloat(cs.paddingBottom || "0");
      const { charW, lineH } = metrics();
      const cols = Math.max(20, Math.floor((el.clientWidth - padX) / charW));
      const rows = Math.max(5, Math.floor((el.clientHeight - padY) / lineH));
      return { cols, rows };
    };

    const ro = new ResizeObserver(() => {
      // While the window is minimized (display:none) the pane measures 0×0 —
      // skip, or we'd shrink the tmux window to its minimum for no reason.
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      const { cols, rows } = compute();
      const key = `${cols}x${rows}`;
      if (key === last) return;
      last = key;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resize: { cols, rows } }),
        })
          .then(() => refresh())
          .catch(() => {});
      }, 200);
    });
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
    // fontSize is a dep so changing it re-measures and reshapes tmux: the pane's
    // pixel box is unchanged, so only the char metrics (not a resize event) shift.
  }, [base, refresh, fontSize]);

  // Stick to the newest output, but only while the user is already at (or near)
  // the bottom. Once they scroll up to read scrollback, leave their position
  // alone so incoming output every poll doesn't yank them back down.
  //
  // Re-rendering the whole pane each poll can make the browser reset scrollTop,
  // which fires a `scroll` event; if we treated that as a user scroll we'd flip
  // `stick` off and the view would freeze mid-stream. So we guard our own
  // programmatic scrolls with `applying` and ignore scroll events during them —
  // only genuine user scrolls update `stick`.
  const stick = useRef(true);
  const applying = useRef(false);
  const pinToBottom = useCallback(() => {
    const el = screenRef.current;
    if (!el) return;
    applying.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      applying.current = false;
    });
  }, []);
  const onScroll = useCallback(() => {
    if (applying.current) return; // ignore programmatic / re-render resets
    const el = screenRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);
  useEffect(() => {
    if (stick.current) pinToBottom();
  }, [content, pinToBottom]);

  // When the window is opened or restored (becomes visible), focus the screen
  // so keystrokes go to the terminal immediately — no click needed. (A hidden
  // element can't hold focus, so this only fires once it's actually shown.)
  useEffect(() => {
    if (minimized) return;
    const el = screenRef.current;
    if (!el) return;
    const id = setTimeout(() => {
      // On mobile, don't auto-focus the pane: focus belongs to the hidden
      // textarea (raised on tap), and focusing the pane here would hide the
      // "tap to type" hint without actually opening the keyboard.
      if (!mobile) el.focus();
      stick.current = true;
      pinToBottom();
    }, 30);
    return () => clearTimeout(id);
  }, [minimized, mobile, pinToBottom]);

  // One POST at a time, in order: without this, fast typing raced (each key was
  // its own request) and tmux received characters transposed. A single pump
  // drains a queue and coalesces adjacent text ops, so a burst of keys is still
  // just one or two requests — ordered, not raced.
  const queue = useRef<Array<{ text?: string; key?: string }>>([]);
  const pumping = useRef(false);

  const postSend = useCallback(
    async (payload: { text?: string; key?: string }) => {
      const mySeq = ++seq.current;
      inflight.current++;
      try {
        const res = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await res.json().catch(() => null);
        // The POST returns the fresh pane (one round-trip, no separate GET).
        if (res.ok && json?.content !== undefined && mySeq === seq.current) {
          applySnap(json);
        }
      } catch {
        /* ignore */
      } finally {
        inflight.current--;
        // After a burst settles, pull one authoritative capture to correct any
        // mis-prediction (e.g. the trailing prompt space that capture strips).
        if (inflight.current === 0) setTimeout(() => void refresh(), 80);
      }
    },
    [base, applySnap, refresh],
  );

  const pump = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
    try {
      while (queue.current.length) {
        // Coalesce a run of literal-text ops into a single send.
        let text = "";
        while (queue.current.length && queue.current[0].text !== undefined) {
          text += queue.current.shift()!.text;
        }
        if (text) {
          await postSend({ text });
          continue;
        }
        const op = queue.current.shift();
        if (op?.key) await postSend({ key: op.key });
      }
    } finally {
      pumping.current = false;
    }
  }, [postSend]);

  const send = useCallback(
    (payload: { text?: string; key?: string }, echo?: string) => {
      // Optimistic local echo: paint the typed char immediately (idle shell
      // only — a TUI redraw can't be predicted by appending). Applied in call
      // order so the echoed text never transposes either.
      if (echo) setContent((c) => c + echo);
      queue.current.push(payload);
      void pump();
    },
    [pump],
  );

  // Paste: a non-editable <pre> never receives a `paste` event, so Cmd/Ctrl+V
  // does nothing on its own. Intercept it and pull the text via the async
  // Clipboard API (the keypress is a user gesture; the site is HTTPS), then send
  // it literally to tmux — same as fast typing.
  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard?.readText();
      if (text) void send({ text });
    } catch {
      /* clipboard blocked / unavailable — ignore */
    }
  }, [send]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Paste (Cmd+V / Ctrl+V) — handle before the meta/ctrl early-returns.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        void pasteFromClipboard();
        return;
      }
      if (e.metaKey) return;
      if (e.ctrlKey && !e.altKey) {
        const mapped = CTRL_KEYS[e.key.toLowerCase()];
        if (mapped) {
          e.preventDefault();
          void send({ key: mapped });
        }
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        void send({ key: e.shiftKey ? "BTab" : "Tab" });
        return;
      }
      const special = SPECIAL_KEYS[e.key];
      if (special) {
        e.preventDefault();
        void send({ key: special });
        return;
      }
      if (e.key.length === 1) {
        e.preventDefault();
        void send({ text: e.key }, status === "idle" ? e.key : undefined);
      }
    },
    [send, status, pasteFromClipboard],
  );

  // --- Mobile input --------------------------------------------------------
  // A <pre> can't summon the soft keyboard, so on mobile a hidden <textarea>
  // owns focus. Soft keyboards fire `beforeinput`/`input` rather than reliable
  // keydowns, so we split: beforeinput handles Enter/Backspace (which don't
  // change the field once we cancel them), and input handles inserted text and
  // paste (read the value, forward it, clear). Hardware keyboards are covered by
  // the shared onKeyDown, which preventDefaults and thus suppresses these.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [ctrlArmed, setCtrlArmed] = useState(false);

  const onBeforeInput = useCallback(
    (e: React.FormEvent<HTMLTextAreaElement>) => {
      const type = (e.nativeEvent as InputEvent).inputType;
      if (type === "insertLineBreak" || type === "insertParagraph") {
        e.preventDefault();
        void send({ key: "Enter" });
      } else if (
        type === "deleteContentBackward" ||
        type === "deleteContent"
      ) {
        e.preventDefault();
        void send({ key: "BSpace" });
      }
      // insertText / paste fall through to onInput below.
    },
    [send],
  );

  const onInput = useCallback(
    (e: React.FormEvent<HTMLTextAreaElement>) => {
      const el = e.currentTarget;
      const data = el.value;
      el.value = ""; // consume: forward to tmux, keep the field empty
      if (!data) return;
      if (ctrlArmed && /^[a-z]$/i.test(data)) {
        void send({ key: `C-${data.toLowerCase()}` });
        setCtrlArmed(false);
        return;
      }
      void send({ text: data }, status === "idle" ? data : undefined);
    },
    [send, status, ctrlArmed],
  );

  const tapKey = useCallback(
    (key: string) => {
      void send({ key });
      inputRef.current?.focus();
    },
    [send],
  );

  const tapText = useCallback(
    (text: string) => {
      void send({ text });
      inputRef.current?.focus();
    },
    [send],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Hidden metrics probe: 50 chars wide, 2 lines tall, same font as the
          screen — lets us map pixels → tmux cols/rows precisely. */}
      <span
        ref={measureRef}
        aria-hidden
        className={`pointer-events-none invisible absolute font-mono ${fontSize} leading-relaxed whitespace-pre`}
      >
        {"0".repeat(50) + "\n0"}
      </span>
      {/* On mobile the control bar sits ABOVE the pane, so the keyboard ends up
          directly under the terminal output — nothing between the prompt and the
          keys. Covers what a soft keyboard lacks (Esc, Ctrl, Tab/Shift-Tab,
          arrows) plus a standalone Enter so commands run with the keyboard down. */}
      {mobile && (
        <div className="shrink-0 border-b bg-background">
          <div className="flex items-center gap-1 overflow-x-auto px-2 py-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <BarKey label="Esc" onTap={() => tapKey("Escape")} />
            <BarKey label="Tab" onTap={() => tapKey("Tab")} />
            <BarKey label="⇧Tab" onTap={() => tapKey("BTab")} />
            <BarKey label="⏎" onTap={() => tapKey("Enter")} />
            <BarKey
              label="Ctrl"
              active={ctrlArmed}
              onTap={() => {
                setCtrlArmed((v) => !v);
                inputRef.current?.focus();
              }}
            />
            <BarKey label="^C" onTap={() => tapKey("C-c")} />
            <BarKey label="^D" onTap={() => tapKey("C-d")} />
            <BarKey label="←" onTap={() => tapKey("Left")} />
            <BarKey label="↓" onTap={() => tapKey("Down")} />
            <BarKey label="↑" onTap={() => tapKey("Up")} />
            <BarKey label="→" onTap={() => tapKey("Right")} />
            <BarKey label="Clear" onTap={() => tapKey("C-l")} />
            <BarKey label="|" onTap={() => tapText("|")} />
            <BarKey label="~" onTap={() => tapText("~")} />
            <BarKey label="/" onTap={() => tapText("/")} />
          </div>
        </div>
      )}
      <pre
        ref={screenRef}
        tabIndex={0}
        onKeyDown={mobile ? undefined : onKeyDown}
        onScroll={onScroll}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={mobile ? () => inputRef.current?.focus() : undefined}
        className={`min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-zinc-950 p-3 font-mono ${fontSize} leading-relaxed whitespace-pre text-zinc-100 outline-none ${
          focused && !mobile ? "ring-2 ring-ring ring-inset" : ""
        }`}
      >
        {content ? <AnsiText text={content} /> : "…"}
      </pre>

      {mobile && (
        <>
          {/* Invisible, focusable input — a <pre> can't raise the soft keyboard,
              so this does. Tapping the pane (or a control key) focuses it; typed
              text goes straight to tmux and the field stays empty. */}
          <textarea
            ref={inputRef}
            rows={1}
            defaultValue=""
            onKeyDown={onKeyDown}
            onBeforeInput={onBeforeInput}
            onInput={onInput}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            inputMode="text"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            aria-label="Terminal input"
            className="pointer-events-none absolute bottom-0 left-0 size-px resize-none border-0 bg-transparent p-0 text-transparent opacity-0 outline-none"
          />
          {/* Faint hint until the keyboard is up (reappears when it's dismissed). */}
          {!focused && (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
              <span className="rounded-full bg-background/85 px-3 py-1 text-xs text-muted-foreground shadow ring-1 ring-foreground/10 backdrop-blur">
                {ctrlArmed ? "Ctrl armed — tap a key" : "Tap the terminal to type"}
              </span>
            </div>
          )}
        </>
      )}
      {!mobile && (
        <div
          style={
            footerBg
              ? { backgroundColor: footerBg, color: textOn(footerBg) }
              : undefined
          }
          className="flex flex-wrap items-center gap-2 border-t px-2 py-1.5"
        >
          <span
            className={`flex items-center gap-1.5 text-xs ${
              footerBg ? "opacity-80" : "text-muted-foreground"
            }`}
          >
            <TermStatusDot status={status} />
            {statusLabel(status)}
            {size && ` · ${size}`}
          </span>
          <div className="ml-auto flex flex-wrap gap-1">
            {(
              [
                ["Ctrl-C", "C-c"],
                ["Ctrl-D", "C-d"],
                ["Tab", "Tab"],
                ["Esc", "Escape"],
                ["↑", "Up"],
                ["↓", "Down"],
                ["Clear", "C-l"],
                ["Enter", "Enter"],
              ] as const
            ).map(([label, key]) => (
              <Button
                key={label}
                size="sm"
                variant="outline"
                className="h-6 px-2 font-mono text-xs"
                onClick={() => {
                  void send({ key });
                  screenRef.current?.focus();
                }}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A single tappable key in the mobile control bar. */
function BarKey({
  label,
  onTap,
  active,
}: {
  label: string;
  onTap: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onTap}
      className={`shrink-0 rounded-md border px-2.5 py-1.5 font-mono text-xs ${
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "bg-background text-foreground active:bg-muted"
      }`}
    >
      {label}
    </button>
  );
}
