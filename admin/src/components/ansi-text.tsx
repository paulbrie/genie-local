"use client";

import * as React from "react";

/**
 * Minimal ANSI-SGR → React renderer for tmux `capture-pane -e` output.
 * Handles the escape sequences a captured pane actually contains: colours
 * (16 / 256 / truecolour), bold, dim, italic, underline, and inverse. Any
 * other CSI sequence is dropped. No dependency needed.
 */

type Style = {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
};

const DEFAULT_FG = "#e5e5e5";
const DEFAULT_BG = "#09090b"; // matches the pre's bg-zinc-950

// Standard + bright 16-colour palette (xterm-ish).
const NORMAL = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510",
  "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
];
const BRIGHT = [
  "#666666", "#f14c4c", "#23d18b", "#f5f543",
  "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

/** xterm 256-colour index → hex. */
function color256(n: number): string {
  if (n < 8) return NORMAL[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const i = n - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const c = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return rgb(c(r), c(g), c(b));
  }
  const v = 8 + (n - 232) * 10;
  return rgb(v, v, v);
}

function rgb(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Apply one SGR parameter list to the running style. */
function applySgr(style: Style, params: number[]): Style {
  const s = { ...style };
  for (let i = 0; i < params.length; i++) {
    const code = params[i];
    if (code === 0) {
      // reset
      s.fg = s.bg = undefined;
      s.bold = s.dim = s.italic = s.underline = s.inverse = false;
    } else if (code === 1) s.bold = true;
    else if (code === 2) s.dim = true;
    else if (code === 3) s.italic = true;
    else if (code === 4) s.underline = true;
    else if (code === 7) s.inverse = true;
    else if (code === 22) s.bold = s.dim = false;
    else if (code === 23) s.italic = false;
    else if (code === 24) s.underline = false;
    else if (code === 27) s.inverse = false;
    else if (code >= 30 && code <= 37) s.fg = NORMAL[code - 30];
    else if (code === 39) s.fg = undefined;
    else if (code >= 40 && code <= 47) s.bg = NORMAL[code - 40];
    else if (code === 49) s.bg = undefined;
    else if (code >= 90 && code <= 97) s.fg = BRIGHT[code - 90];
    else if (code >= 100 && code <= 107) s.bg = BRIGHT[code - 100];
    else if (code === 38 || code === 48) {
      // extended colour: 5;<n>  or  2;<r>;<g>;<b>
      const target: "fg" | "bg" = code === 38 ? "fg" : "bg";
      const mode = params[i + 1];
      if (mode === 5) {
        s[target] = color256(params[i + 2] ?? 0);
        i += 2;
      } else if (mode === 2) {
        s[target] = rgb(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0);
        i += 4;
      }
    }
  }
  return s;
}

function styleToCss(s: Style): React.CSSProperties {
  const css: React.CSSProperties = {};
  let fg = s.fg;
  let bg = s.bg;
  if (s.inverse) {
    fg = s.bg ?? DEFAULT_BG;
    bg = s.fg ?? DEFAULT_FG;
  }
  if (fg) css.color = fg;
  if (bg) css.backgroundColor = bg;
  if (s.bold) css.fontWeight = 700;
  if (s.dim) css.opacity = 0.7;
  if (s.italic) css.fontStyle = "italic";
  if (s.underline) css.textDecoration = "underline";
  return css;
}

// Matches an SGR sequence (captured params) OR any other CSI/OSC sequence
// (dropped). Kept as a string so each render builds a fresh stateful regex.
// The OSC branch (e.g. OSC-8 hyperlinks Claude emits around file paths) must
// end NON-GREEDILY at either BEL (\x07) or ST (\x1b\\); a greedy BEL-only match
// would swallow everything after the first hyperlink and truncate the output.
const ANSI_PATTERN =
  "\\x1b\\[([0-9;]*)m|\\x1b\\[[0-9;?]*[A-Za-z]|\\x1b\\][\\s\\S]*?(?:\\x07|\\x1b\\\\)";

export function AnsiText({ text }: { text: string }) {
  const nodes: React.ReactNode[] = [];
  const re = new RegExp(ANSI_PATTERN, "g");
  let style: Style = {};
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;

  const emit = (chunk: string) => {
    if (!chunk) return;
    const css = styleToCss(style);
    nodes.push(
      Object.keys(css).length ? (
        <span key={key++} style={css}>
          {chunk}
        </span>
      ) : (
        <React.Fragment key={key++}>{chunk}</React.Fragment>
      ),
    );
  };

  while ((m = re.exec(text))) {
    emit(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] !== undefined) {
      const params = m[1] === "" ? [0] : m[1].split(";").map((n) => Number(n) || 0);
      style = applySgr(style, params);
    }
    // other CSI/OSC sequences: skip
  }
  emit(text.slice(last));

  return <>{nodes}</>;
}
