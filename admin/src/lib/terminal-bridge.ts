/**
 * xterm.js ↔ WebSocket bridge for the admin terminal dock.
 *
 * Replaces the old HTTP-poll + tmux `capture-pane` rendering: each open terminal
 * window gets a real xterm wired over a WebSocket (`<basePath>/pty`) to a PTY on
 * the server running `tmux attach-session -t admin-<name>`. Keystrokes go up as
 * tiny frames; PTY output streams back (16ms-batched, base64) and is written to
 * xterm incrementally. Same-origin, so the browser sends the admin_session
 * cookie on the handshake — the server authenticates the upgrade.
 *
 * One xterm + one WebSocket per terminal name. Adapted from genie's
 * packages/renderer/src/lib/terminal-bridge.ts.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import { BASE_PATH } from "@/lib/config";

const THEME = {
  background: "#09090b", // zinc-950, matches the old pane
  foreground: "#e4e4e7",
  cursor: "#f5e0dc",
  cursorAccent: "#09090b",
  selectionBackground: "#45475a",
  selectionForeground: "#cdd6f4",
  black: "#45475a",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#cba6f7",
  cyan: "#94e2d5",
  white: "#bac2de",
  brightBlack: "#585b70",
  brightRed: "#f38ba8",
  brightGreen: "#a6e3a1",
  brightYellow: "#f9e2af",
  brightBlue: "#89b4fa",
  brightMagenta: "#cba6f7",
  brightCyan: "#94e2d5",
  brightWhite: "#a6adc8",
};

export type ConnState = "connecting" | "open" | "closed";

interface Instance {
  terminal: Terminal;
  fit: FitAddon;
  ws: WebSocket | null;
  /** Stops the fit watchers (container resize, DPR, fonts, tab return). */
  resizeObserver: { disconnect(): void };
  name: string;
  onConn?: (s: ConnState) => void;
  disposed: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

const instances = new Map<string, Instance>();

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${BASE_PATH}/pty`;
}

/** rAF-coalesced fit → resize (see genie: an unbounded/debounced mismatch makes
 *  a TUI compute cursor math against the wrong size and stack its prompt).
 *
 *  Re-fits not only when the container changes size but whenever the cell size
 *  can change under it: a move to a screen with another pixel density, browser
 *  zoom, a font finishing loading, or coming back to the tab. Otherwise the grid
 *  keeps its column count at the new, wider cells and the right edge (e.g. the
 *  end of tmux's status line) runs past the window. Sending an unchanged size
 *  is harmless: tmux ignores it. */
function installFitOnResize(container: HTMLElement, inst: Instance): { disconnect(): void } {
  let pending = false;
  const flush = () => {
    pending = false;
    try {
      const hadFocus = !!inst.terminal.element?.contains(document.activeElement);
      fitChecked(inst);
      sendResize(inst);
      if (hadFocus) inst.terminal.focus();
    } catch { /* tear-down race */ }
  };
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(flush);
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(container);

  // Pixel density (screen change, zoom): a media query that only matches the
  // current ratio fires once it changes; re-armed for the new ratio each time.
  let dprQuery: MediaQueryList | null = null;
  const onDpr = () => {
    dprQuery?.removeEventListener("change", onDpr);
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprQuery.addEventListener("change", onDpr);
    schedule();
  };
  dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  dprQuery.addEventListener("change", onDpr);
  const onVisible = () => {
    if (!document.hidden) schedule();
  };
  document.addEventListener("visibilitychange", onVisible);
  document.fonts?.addEventListener("loadingdone", schedule);
  // Once more after things settle (late fonts don't always fire loadingdone).
  const settle = setTimeout(schedule, 1000);

  return {
    disconnect() {
      observer.disconnect();
      dprQuery?.removeEventListener("change", onDpr);
      document.removeEventListener("visibilitychange", onVisible);
      document.fonts?.removeEventListener("loadingdone", schedule);
      clearTimeout(settle);
    },
  };
}

/**
 * Fit, then check the grid really fits: the FitAddon sizes columns from the
 * cell width xterm *measured*, which can be narrower than what the browser
 * ends up drawing (a font that wasn't available yet, or not under the name we
 * asked for). Then the last columns, e.g. the end of tmux's status line, run
 * past the window. If the drawn grid overflows its box, recount the columns
 * from the drawn cell width.
 */
function fitChecked(inst: Instance): void {
  inst.fit.fit();
  const el = inst.terminal.element;
  const screen = el?.querySelector<HTMLElement>(".xterm-screen");
  const box = el?.parentElement;
  if (!screen || !box || inst.terminal.cols < 2) return;
  const cs = getComputedStyle(box);
  const avail = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const drawn = screen.getBoundingClientRect().width;
  if (drawn <= avail + 0.5) return;
  const cell = drawn / inst.terminal.cols;
  const cols = Math.max(2, Math.floor(avail / cell));
  if (cols < inst.terminal.cols) inst.terminal.resize(cols, inst.terminal.rows);
}

function sendResize(inst: Instance) {
  if (inst.ws?.readyState === WebSocket.OPEN) {
    try {
      inst.ws.send(JSON.stringify({ type: "pty:resize", payload: { cols: inst.terminal.cols, rows: inst.terminal.rows } }));
    } catch { /* closed */ }
  }
}

function connect(inst: Instance) {
  if (inst.disposed) return;
  inst.onConn?.("connecting");
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect(inst);
    return;
  }
  inst.ws = ws;

  ws.onopen = () => {
    inst.onConn?.("open");
    inst.terminal.options.cursorBlink = true;
    try {
      ws.send(JSON.stringify({ type: "pty:start", payload: { name: inst.name, cols: inst.terminal.cols, rows: inst.terminal.rows } }));
    } catch { /* ignore */ }
  };

  ws.onmessage = (ev) => {
    let msg: { type?: string; payload?: { dataB64?: string; message?: string; exitCode?: number } };
    try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
    if (msg.type === "pty:output" && msg.payload?.dataB64) {
      try {
        const bytes = Uint8Array.from(atob(msg.payload.dataB64), (c) => c.charCodeAt(0));
        inst.terminal.write(bytes);
      } catch { /* ignore decode error */ }
    } else if (msg.type === "pty:error") {
      inst.terminal.write(`\r\n\x1b[31m[${msg.payload?.message ?? "terminal error"}]\x1b[0m\r\n`);
    } else if (msg.type === "pty:exit") {
      // tmux attach ended (session gone or detached server-side).
      inst.terminal.write(`\r\n\x1b[33m[disconnected]\x1b[0m\r\n`);
    }
  };

  ws.onclose = () => {
    inst.ws = null;
    inst.terminal.options.cursorBlink = false; // steady cursor = not live
    inst.onConn?.("closed");
    scheduleReconnect(inst);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}

function scheduleReconnect(inst: Instance) {
  if (inst.disposed || inst.reconnectTimer) return;
  inst.reconnectTimer = setTimeout(() => {
    inst.reconnectTimer = null;
    if (!inst.disposed) connect(inst);
  }, 1500);
}

export function createTerminal(
  container: HTMLElement,
  name: string,
  fontSize = 12,
  onConn?: (s: ConnState) => void,
): Terminal {
  disposeTerminal(name); // never leak a prior instance for the same name

  const terminal = new Terminal({
    theme: THEME,
    fontFamily: '"SF Mono", "Fira Code", ui-monospace, monospace',
    fontSize,
    lineHeight: 1.2,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10000,
  });

  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(container);

  // Canvas renderer: ~10× faster than DOM for chatty TUI output. Async because
  // the addon touches `self` at eval time, which crashes Next's SSR prerender if
  // imported statically. Falls back to the DOM renderer if it fails.
  void import("@xterm/addon-canvas")
    .then(({ CanvasAddon }) => { try { terminal.loadAddon(new CanvasAddon()); } catch { /* DOM fallback */ } })
    .catch(() => { /* ignore */ });

  // OSC 52 → system clipboard (tmux/Claude can write selections).
  terminal.parser.registerOscHandler(52, (data) => {
    const semi = data.indexOf(";");
    if (semi < 0) return false;
    const payload = data.slice(semi + 1);
    if (payload === "?" || payload === "") return true;
    try {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      void navigator.clipboard?.writeText(new TextDecoder().decode(bytes));
    } catch { return false; }
    return true;
  });

  const inst: Instance = {
    terminal, fit, ws: null, name, onConn, disposed: false, reconnectTimer: null,
    resizeObserver: { disconnect() {} },
  };

  // keystrokes → server
  terminal.onData((data) => {
    if (inst.ws?.readyState === WebSocket.OPEN) {
      try { inst.ws.send(JSON.stringify({ type: "pty:data", payload: { data } })); } catch { /* closed */ }
    }
  });

  requestAnimationFrame(() => {
    try { fitChecked(inst); } catch { /* ignore */ }
    terminal.focus();
  });

  inst.resizeObserver = installFitOnResize(container, inst);
  instances.set(name, inst);
  connect(inst);
  return terminal;
}

/** Send raw bytes to the PTY (control keys, voice text, pasted text/paths). */
export function writeToPty(name: string, data: string): void {
  const inst = instances.get(name);
  if (!inst || !data) return;
  if (inst.ws?.readyState === WebSocket.OPEN) {
    try { inst.ws.send(JSON.stringify({ type: "pty:data", payload: { data } })); } catch { /* closed */ }
  }
}

/** Paste clipboard text the way a real terminal does: via xterm's paste(), which
 *  wraps it in bracketed-paste markers when the focused app (shell, tmux, Claude)
 *  has that mode on. Sending raw text (writeToPty) instead makes every newline
 *  submit, so multi-line pastes execute line-by-line. Goes out over the WS through
 *  the same onData path as typing. */
export function pasteToTerminal(name: string, data: string): void {
  const inst = instances.get(name);
  if (!inst || !data) return;
  try { inst.terminal.paste(data); inst.terminal.focus(); } catch { /* disposed */ }
}

export function focusTerminal(name: string): void {
  instances.get(name)?.terminal.focus();
}

export function refitTerminal(name: string): void {
  const inst = instances.get(name);
  if (!inst) return;
  try { fitChecked(inst); sendResize(inst); } catch { /* ignore */ }
}

export function setTerminalFontSize(name: string, fontSize: number): void {
  const inst = instances.get(name);
  if (!inst || inst.terminal.options.fontSize === fontSize) return;
  inst.terminal.options.fontSize = fontSize;
  try { fitChecked(inst); sendResize(inst); } catch { /* ignore */ }
}

export function hasTerminal(name: string): boolean {
  return instances.has(name);
}

/** Move an existing xterm into a new container (window re-mount). */
export function reattachTerminal(name: string, newContainer: HTMLElement): boolean {
  const inst = instances.get(name);
  if (!inst) return false;
  inst.resizeObserver.disconnect();
  const el = inst.terminal.element;
  if (el && el.parentElement !== newContainer) newContainer.appendChild(el);
  inst.resizeObserver = installFitOnResize(newContainer, inst);
  // Fit AND tell the PTY: a re-mounted window can have another size.
  requestAnimationFrame(() => { try { fitChecked(inst); sendResize(inst); inst.terminal.focus(); } catch { /* ignore */ } });
  return true;
}

export function disposeTerminal(name: string): void {
  const inst = instances.get(name);
  if (!inst) return;
  inst.disposed = true;
  if (inst.reconnectTimer) { clearTimeout(inst.reconnectTimer); inst.reconnectTimer = null; }
  inst.resizeObserver?.disconnect();
  try { inst.ws?.close(); } catch { /* ignore */ }
  instances.delete(name);
  setTimeout(() => { try { inst.terminal.dispose(); } catch { /* ignore */ } }, 0);
}
