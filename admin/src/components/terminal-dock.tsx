"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import {
  ALargeSmall,
  Check,
  ChevronLeft,
  ClipboardPaste,
  Mic,
  Minus,
  Palette,
  Pencil,
  Pipette,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { useSubject } from "subjecto/react";

import "@xterm/xterm/css/xterm.css";

import { ClaudeGlyph, claudeGlyphState } from "@/components/claude-glyph";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { BASE_PATH } from "@/lib/config";
import { useIsMobile } from "@/lib/use-is-mobile";
import { SPEECH_LANGS, useSpeechInput } from "@/lib/use-speech-input";
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
import {
  type ConnState,
  createTerminal,
  disposeTerminal,
  focusTerminal,
  hasTerminal,
  reattachTerminal,
  refitTerminal,
  setTerminalFontSize,
  writeToPty,
} from "@/lib/terminal-bridge";

const API = `${BASE_PATH}/api/terminals`;
// Status dot / token meter refresh. Metadata only now — the live pane streams
// over the PTY WebSocket — so it can poll lazily instead of every second.
const STATUS_POLL_MS = 2500;

// A palette of deep, dark tones for the window bars — all dark enough that the
// white bar text stays legible on top. For anything else there's a colour
// picker (see BarPalette), whose text colour still adapts via `textOn`.
const PALETTE: { name: string; value: string }[] = [
  { name: "Charcoal", value: "#1e1e2e" },
  { name: "Graphite", value: "#2b2d31" },
  { name: "Slate", value: "#334155" },
  { name: "Navy", value: "#1e293b" },
  { name: "Midnight", value: "#172554" },
  { name: "Indigo", value: "#312e81" },
  { name: "Violet", value: "#3b0764" },
  { name: "Plum", value: "#4a044e" },
  { name: "Wine", value: "#4c0519" },
  { name: "Maroon", value: "#450a0a" },
  { name: "Rust", value: "#431407" },
  { name: "Umber", value: "#422006" },
  { name: "Forest", value: "#052e16" },
  { name: "Pine", value: "#022c22" },
  { name: "Teal", value: "#042f2e" },
  { name: "Ocean", value: "#083344" },
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

/** The Claude token meter parsed server-side from a session's status line. */
type TokenMeter = { input: number; output: number; total: number };

/** Compact token count: 1_234 → "1.2k", 2_500_000 → "2.5M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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
  // Which floating window is frontmost/focused — it gets the glow so it's clear
  // which one keystrokes go to. Set on open and on any interaction.
  const [activeName, setActiveName] = useState<string | null>(null);
  const activate = useCallback((name: string) => setActiveName(name), []);

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
          const list: {
            name: string;
            status?: TermStatus;
            tokens?: TokenMeter | null;
          }[] = json.terminals ?? [];
          reconcileTerminals(list.map((t) => t.name));
          for (const t of list) {
            if (t.status) setTerminalStatus(t.name, t.status);
          }
          setLiveTerminals(
            list.map((t) => ({
              name: t.name,
              status: t.status ?? "idle",
              tokens: t.tokens ?? null,
            })),
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
          active={activeName === name}
          onActivate={() => activate(name)}
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
                onClick={() => {
                  restoreTerminal(name);
                  activate(name);
                }}
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
  active,
  onActivate,
  bringToFront,
  onMinimize,
  onClose,
  onKill,
  onRename,
}: {
  name: string;
  index: number;
  minimized: boolean;
  active: boolean;
  onActivate: () => void;
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
  const paletteRef = useRef<HTMLDivElement>(null);
  const paletteBtnRef = useRef<HTMLButtonElement>(null);

  // Load persisted per-terminal prefs (client-only; localStorage is unavailable
  // during SSR, so this must run after mount).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setColor(loadBarColor(name));
    setFontSize(loadFontSize(name));
  }, [name]);

  // A freshly opened (or restored) window is the one you want to type into, so
  // claim focus/glow on mount. Interactions below keep it in sync thereafter.
  useEffect(() => {
    onActivate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Raise this window and mark it the active (glowing) one — on click anywhere
  // or on a header drag.
  const raise = useCallback(() => {
    setZ(bringToFront());
    onActivate();
  }, [bringToFront, onActivate]);

  // Dismiss the colour palette on a click anywhere outside it (or Escape). The
  // toggle button is excluded so its own onClick keeps handling open/close.
  useEffect(() => {
    if (!paletteOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (paletteRef.current?.contains(t)) return;
      if (paletteBtnRef.current?.contains(t)) return;
      setPaletteOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [paletteOpen]);

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
    raise();
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
      onPointerDown={raise}
      style={{ left: pos.x, top: pos.y, zIndex: z }}
      // Kept mounted while minimized (hidden) so its position, size and live
      // output survive a minimize → restore round-trip. The active window gets a
      // purple drop shadow + subtle border so it's obvious which one has focus.
      className={`fixed flex h-[26rem] max-h-[90vh] min-h-[12rem] w-[44rem] max-w-[92vw] min-w-[20rem] resize flex-col overflow-hidden rounded-lg border bg-background transition-shadow ${
        active
          ? "ring-1 ring-purple-500/30 shadow-[0_0_30px_-2px] shadow-purple-500/50"
          : "ring-1 ring-foreground/10 shadow-2xl"
      } ${minimized ? "hidden" : ""}`}
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
          ref={paletteBtnRef}
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
        <div
          ref={paletteRef}
          className="absolute top-10 right-2 z-10 w-60 rounded-md border bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          <BarPalette label="Window colour" value={color} onPick={pickColor} />
        </div>
      )}

      <TerminalView
        name={name}
        footerBg={color}
        fontSize={fontSize}
        minimized={minimized}
        active={active}
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
  // A colour that isn't one of the presets came from the picker.
  const isCustom = value !== null && !PALETTE.some((c) => c.value === value);
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
      {/* Escape hatch: pick any colour. Its bar text still adapts via textOn,
          so even a light custom colour stays readable. */}
      <label
        className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
        title="Choose a custom colour"
      >
        <span
          className={`relative flex size-6 items-center justify-center overflow-hidden rounded ring-1 ring-black/20 ${
            isCustom ? "outline outline-2 outline-offset-1 outline-ring" : ""
          }`}
          style={
            isCustom
              ? { backgroundColor: value, color: textOn(value) }
              : undefined
          }
        >
          <input
            type="color"
            aria-label={`${label}: custom colour`}
            value={value ?? "#1e1e2e"}
            onChange={(e) => onPick(e.target.value)}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
          {isCustom ? (
            <Check className="size-3.5" />
          ) : (
            <Pipette className="size-3.5" />
          )}
        </span>
        Custom…
      </label>
    </div>
  );
}

/* -------------------------------- status -------------------------------- */

/** Human-readable description of a terminal status. */
export function statusLabel(status: TermStatus): string {
  switch (status) {
    case "claude-working":
      return "Claude is working";
    case "claude-input":
      return "Claude needs your input";
    case "claude-idle":
      return "Claude is idle";
    case "busy":
      return "Running a command";
    default:
      return "Idle — at a shell prompt";
  }
}

// Non-Claude states use the shared coloured dot; class names are literals so
// Tailwind picks them up. Claude sessions get the distinctive spark glyph below
// instead, so an active Claude terminal never looks like a dim idle dot.
const DOT: Record<"idle" | "busy", { dot: string; ping: string | null }> = {
  idle: { dot: "bg-muted-foreground/40", ping: null },
  busy: { dot: "bg-emerald-500", ping: "bg-emerald-400" },
};

/**
 * Status indicator. Grey dot = idle at a prompt, green (pulsing) dot = running a
 * command, and the orange Claude glyph = a Claude session — twinkling through
 * the CLI's spinner glyphs while it works, a steady dimmed spark while idle, and
 * a "?" when it's blocked asking you for input.
 */
export function TermStatusDot({ status }: { status: TermStatus }) {
  const claude = claudeGlyphState(status);
  if (claude) {
    return (
      <span
        role="img"
        aria-label={statusLabel(status)}
        title={statusLabel(status)}
        className="inline-flex size-3.5 items-center justify-center"
      >
        <ClaudeGlyph state={claude} size="md" />
      </span>
    );
  }
  const { dot, ping } = status === "busy" ? DOT.busy : DOT.idle;
  return (
    <StatusDot color={dot} pulse={ping !== null} label={statusLabel(status)} />
  );
}

/* ------------------------------ terminal I/O ---------------------------- */

// tmux font-size class → xterm px.
const FONT_PX: Record<FontSizeCls, number> = {
  "text-xs": 12,
  "text-sm": 14,
  "text-base": 16,
};

// Named control keys (used by the footer buttons + mobile bar) → the raw byte
// sequence written into the PTY. Replaces the old tmux `send-keys` names now
// that input goes straight to a real terminal over the WebSocket.
const KEY_SEQ: Record<string, string> = {
  Enter: "\r",
  Backspace: "\x7f",
  Tab: "\t",
  BTab: "\x1b[Z",
  Escape: "\x1b",
  Up: "\x1b[A",
  Down: "\x1b[B",
  Right: "\x1b[C",
  Left: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  "C-c": "\x03",
  "C-d": "\x04",
  "C-l": "\x0c",
  "C-z": "\x1a",
  "C-a": "\x01",
  "C-e": "\x05",
  "C-u": "\x15",
  "C-k": "\x0b",
  "C-r": "\x12",
};

function TerminalView({
  name,
  footerBg,
  fontSize,
  minimized,
  active,
  mobile,
  onStatus,
}: {
  name: string;
  footerBg?: string | null;
  fontSize: FontSizeCls;
  minimized?: boolean;
  active?: boolean;
  mobile?: boolean;
  onStatus?: (status: TermStatus) => void;
}) {
  const [size, setSize] = useState("");
  const [status, setStatus] = useState<TermStatus>("idle");
  // Cumulative token total for this Claude session (summed across turns on the
  // server). Kept until the session stops being a Claude session, so the total
  // stays visible after a turn finishes (the CLI only prints its meter while
  // working).
  const [tokens, setTokens] = useState<TokenMeter | null>(null);
  const [conn, setConn] = useState<ConnState>("connecting");
  const containerRef = useRef<HTMLDivElement>(null);
  const base = `${API}/${encodeURIComponent(name)}`;

  // Keep the latest onStatus without re-creating the poll on every render.
  const onStatusRef = useRef(onStatus);
  useEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);

  // xterm lifecycle: create on mount, dispose on unmount (window close).
  // Minimizing only hides the window (this component stays mounted), so the live
  // session, scrollback, and WebSocket all persist across minimize/restore.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (hasTerminal(name)) reattachTerminal(name, el);
    else createTerminal(el, name, FONT_PX[fontSize], setConn);
    return () => {
      disposeTerminal(name);
    };
    // `name` identifies the window; font size is handled by its own effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  // Font-size change → resize xterm + refit (which re-sizes the attached PTY).
  useEffect(() => {
    if (hasTerminal(name)) setTerminalFontSize(name, FONT_PX[fontSize]);
  }, [name, fontSize]);

  // Refit + focus when the window is shown or becomes the active one.
  useEffect(() => {
    if (minimized) return;
    const id = setTimeout(() => {
      refitTerminal(name);
      if (!mobile && active) focusTerminal(name);
    }, 30);
    return () => clearTimeout(id);
  }, [name, minimized, active, mobile]);

  // Status dot / token meter: metadata only now, polled lazily from the tmux
  // capture endpoint (the live pane streams over the PTY WS). Paused while
  // minimized. Its `content` is ignored — we only read status/size/tokens.
  useEffect(() => {
    if (minimized) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(base, { cache: "no-store" });
        const json = await res.json();
        if (!alive || !res.ok) return;
        const s: TermStatus = json.status ?? "idle";
        setStatus(s);
        setSize(json.size ?? "");
        if (claudeGlyphState(s)) {
          if (json.tokens) setTokens(json.tokens);
        } else {
          setTokens(null);
        }
        onStatusRef.current?.(s);
      } catch {
        /* transient */
      }
    };
    void tick();
    const id = setInterval(tick, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [base, name, minimized]);

  // Named control keys and literal text both go straight to the PTY. xterm sizes
  // itself via the FitAddon (see terminal-bridge), so there's no tmux reshape or
  // pixel↔cols math here anymore.
  const sendKey = useCallback(
    (key: string) => {
      const seq = KEY_SEQ[key];
      if (seq !== undefined) writeToPty(name, seq);
      focusTerminal(name);
    },
    [name],
  );

  const sendText = useCallback(
    (text: string) => {
      writeToPty(name, text);
      focusTerminal(name);
    },
    [name],
  );

  // Scroll-stick, focus-on-show/active, and ordered keystroke delivery are all
  // xterm's job now (the FitAddon + the terminal's own scrollback + the ordered
  // WebSocket stream), so the old ResizeObserver metrics, scroll bookkeeping, and
  // POST queue/pump are gone.

  // Paste: xterm handles a plain Cmd/Ctrl+V into the focused pane natively (it
  // fires onData with the text). This handler backs the explicit Paste button
  // (needed on mobile / when the shortcut is awkward) and, crucially, IMAGE
  // paste: a screenshot can't stream into a shell, so it's uploaded and its saved
  // absolute path is typed into the pane instead — a `claude` session there can
  // read it. Both entry points are user gestures, so the async Clipboard read is
  // permitted; surface why nothing happened.
  const pasteFromClipboard = useCallback(async () => {
    const pasteImage = async (blob: Blob, mime: string) => {
      const res = await fetch(`${base}/image`, {
        method: "POST",
        headers: { "Content-Type": mime },
        body: blob,
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.path) {
        writeToPty(name, `${json.path} `); // trailing space separates it
        toast.success("Screenshot pasted");
      } else {
        toast.error(json?.error ?? "Couldn't paste image");
      }
    };
    const pasteText = async () => {
      const text = await navigator.clipboard?.readText();
      if (text) writeToPty(name, text);
      else toast.info("Clipboard is empty");
    };
    try {
      // Prefer read() so image items are visible; readText() is the fallback.
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imgType = item.types.find((t) => t.startsWith("image/"));
          if (imgType) {
            await pasteImage(await item.getType(imgType), imgType);
            return;
          }
        }
        const textItem = items.find((i) => i.types.includes("text/plain"));
        if (textItem) {
          const text = await (await textItem.getType("text/plain")).text();
          if (text) writeToPty(name, text);
          else toast.info("Clipboard is empty");
          return;
        }
        toast.info("Clipboard is empty");
        return;
      }
      await pasteText();
    } catch {
      // read()/readText() can throw on permission/focus; try plain text once more.
      try {
        await pasteText();
      } catch {
        toast.error("Clipboard is blocked — allow clipboard access to paste");
      }
    }
  }, [base, name]);

  // xterm owns key input (hardware + soft keyboards, IME, paste) and streams it
  // over the WebSocket, so the old onKeyDown / hidden-textarea handlers are gone.
  // The mobile control bar + footer buttons drive sendKey/sendText directly.

  // Voice input: dictate straight into the terminal. Each finalized phrase is
  // sent as literal text (no auto-Enter — the user reviews and runs it). Gated on
  // `supported` so the mic UI only shows in browsers that have the Web Speech API.
  const speech = useSpeechInput({
    onText: (text) => writeToPty(name, text),
    onError: (msg) => toast.error(msg),
  });

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* On mobile the control bar sits ABOVE the pane, so the soft keyboard ends
          up directly under the terminal output. Covers what a soft keyboard lacks
          (Esc, Tab/Shift-Tab, arrows) plus a standalone Enter. */}
      {mobile && (
        <div className="shrink-0 border-b bg-background">
          <div className="flex items-center gap-1 overflow-x-auto px-2 py-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <BarKey label="Esc" onTap={() => sendKey("Escape")} />
            <BarKey label="Tab" onTap={() => sendKey("Tab")} />
            <BarKey label="⇧Tab" onTap={() => sendKey("BTab")} />
            <BarKey label="⏎" onTap={() => sendKey("Enter")} />
            <BarKey label="Paste" onTap={() => void pasteFromClipboard()} />
            {speech.supported && (
              <>
                <BarKey
                  label={speech.listening ? "🎤 Stop" : "🎤 Talk"}
                  active={speech.listening}
                  onTap={() => {
                    speech.toggle();
                    focusTerminal(name);
                  }}
                />
                <select
                  aria-label="Voice input language"
                  value={speech.lang}
                  onChange={(e) => speech.setLang(e.target.value)}
                  className="shrink-0 rounded-md border bg-background px-2 py-1.5 font-mono text-xs text-foreground"
                >
                  {!SPEECH_LANGS.some((l) => l.value === speech.lang) &&
                    speech.lang && (
                      <option value={speech.lang}>{speech.lang}</option>
                    )}
                  {SPEECH_LANGS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </>
            )}
            <BarKey label="^C" onTap={() => sendKey("C-c")} />
            <BarKey label="^D" onTap={() => sendKey("C-d")} />
            <BarKey label="←" onTap={() => sendKey("Left")} />
            <BarKey label="↓" onTap={() => sendKey("Down")} />
            <BarKey label="↑" onTap={() => sendKey("Up")} />
            <BarKey label="→" onTap={() => sendKey("Right")} />
            <BarKey label="Clear" onTap={() => sendKey("C-l")} />
            <BarKey label="|" onTap={() => sendText("|")} />
            <BarKey label="~" onTap={() => sendText("~")} />
            <BarKey label="/" onTap={() => sendText("/")} />
          </div>
        </div>
      )}
      {/* Live xterm pane. On mobile, tapping it focuses xterm's own hidden
          textarea, which raises the soft keyboard. */}
      <div
        ref={containerRef}
        onClick={mobile ? () => focusTerminal(name) : undefined}
        className="min-h-0 flex-1 overflow-hidden bg-zinc-950 p-2"
      />
      {conn !== "open" && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <span className="rounded-full bg-background/85 px-3 py-1 text-xs text-muted-foreground shadow ring-1 ring-foreground/10 backdrop-blur">
            {conn === "connecting" ? "Connecting…" : "Reconnecting…"}
          </span>
        </div>
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
            {tokens && (
              <span
                title={`This session · Input ↑ ${tokens.input.toLocaleString()} · Output ↓ ${tokens.output.toLocaleString()} · Total ${tokens.total.toLocaleString()} tokens`}
                className="font-mono"
              >
                · {fmtTokens(tokens.total)} tokens
              </span>
            )}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1">
            {speech.supported && (
              <>
                {speech.listening && speech.interim && (
                  <span
                    className="max-w-[14rem] truncate text-xs italic opacity-70"
                    title={speech.interim}
                  >
                    “{speech.interim}”
                  </span>
                )}
                <select
                  aria-label="Voice input language"
                  title="Voice input language"
                  value={speech.lang}
                  onChange={(e) => speech.setLang(e.target.value)}
                  style={
                    footerBg
                      ? { backgroundColor: footerBg, color: textOn(footerBg) }
                      : undefined
                  }
                  className={`h-6 rounded-md border px-1 text-xs ${
                    footerBg ? "" : "bg-background text-foreground"
                  }`}
                >
                  {/* Keep an unlisted browser/persisted locale selectable. */}
                  {!SPEECH_LANGS.some((l) => l.value === speech.lang) &&
                    speech.lang && (
                      <option value={speech.lang}>{speech.lang}</option>
                    )}
                  {SPEECH_LANGS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant={speech.listening ? "default" : "outline"}
                  className={`h-6 gap-1 px-2 text-xs ${
                    speech.listening
                      ? "bg-red-600 text-white hover:bg-red-600/90"
                      : ""
                  }`}
                  title={
                    speech.listening
                      ? `Listening in ${speech.lang} — click to stop`
                      : `Talk to the terminal (voice input, ${speech.lang})`
                  }
                  onClick={() => {
                    speech.toggle();
                    focusTerminal(name);
                  }}
                >
                  <Mic
                    className={`size-3 ${speech.listening ? "animate-pulse" : ""}`}
                  />
                  {speech.listening ? `Listening · ${speech.lang}` : "Voice"}
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-2 text-xs"
              title="Paste clipboard into the terminal (⌘/Ctrl+V)"
              onClick={() => {
                void pasteFromClipboard();
                focusTerminal(name);
              }}
            >
              <ClipboardPaste className="size-3" />
              Paste
            </Button>
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
                  sendKey(key);
                  focusTerminal(name);
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
