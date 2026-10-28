"use client";

// The file explorer's Monaco (T243), set up as the Ops view's code windows are (monaco from the package, its workers
// bundled): the language workers too, which Monaco's JSON / CSS / HTML / TS modes ask for (outline, folding), and the
// same mapping as code-window.tsx, so whichever of the two loads first leaves a complete MonacoEnvironment. Read-only
// for the preview, or an editor for a file the server says can be saved (`editable`).
import { Editor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useCallback, useEffect, useRef } from "react";

loader.config({ monaco });
if (typeof self !== "undefined") {
  // (`new URL(...)` literals, each, so webpack bundles the workers)
  const worker = (label: string) => {
    if (label === "typescript" || label === "javascript") return new Worker(new URL("../agents3d/ops/monaco/ts.worker.ts", import.meta.url), { type: "module" });
    if (label === "json") return new Worker(new URL("../agents3d/ops/monaco/json.worker.ts", import.meta.url), { type: "module" });
    if (label === "css" || label === "scss" || label === "less") return new Worker(new URL("../agents3d/ops/monaco/css.worker.ts", import.meta.url), { type: "module" });
    if (label === "html" || label === "handlebars" || label === "razor") return new Worker(new URL("../agents3d/ops/monaco/html.worker.ts", import.meta.url), { type: "module" });
    return new Worker(new URL("../agents3d/ops/monaco/editor.worker.ts", import.meta.url), { type: "module" });
  };
  (self as unknown as { MonacoEnvironment?: { getWorker: (id: string, label: string) => Worker } }).MonacoEnvironment ??= { getWorker: (_id, label) => worker(label) };
}

const LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", json: "json",
  md: "markdown", css: "css", scss: "scss", html: "html", py: "python", sh: "shell", bash: "shell", yml: "yaml", yaml: "yaml",
  sql: "sql", go: "go", rs: "rust", java: "java", cs: "csharp", php: "php", rb: "ruby", xml: "xml", svg: "xml", toml: "ini", ini: "ini", conf: "ini",
  dockerfile: "dockerfile", c: "c", h: "c", cpp: "cpp", kt: "kotlin", swift: "swift", lua: "lua", prisma: "graphql", graphql: "graphql",
};

export function languageOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  return LANG[lower.split(".").pop() ?? ""] ?? "plaintext";
}

/** what the explorer's Save button calls */
export type EditorControls = { save: () => void };

/**
 * `text` grows as the preview loads more pages: what is new is appended to the model (the view keeps its place), and
 * other text (another file) replaces it. `editable`: an editor instead, opened with `text` (remount it, by key, to load
 * other text); it reports whether it differs from what was last saved (`onDirty`, by Monaco's version, so undoing back
 * counts as clean), and Ctrl/Cmd+S or `onReady`'s save hands its text to `onSave`, which resolves true once it's on disk.
 */
export default function MonacoViewer({ name, text, editable = false, onDirty, onSave, onReady }: {
  name: string;
  text: string;
  editable?: boolean;
  onDirty?: (dirty: boolean) => void;
  onSave?: (text: string) => Promise<boolean>;
  onReady?: (controls: EditorControls) => void;
}) {
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const shown = useRef(""), latest = useRef("");
  const sync = useCallback(() => {
    const model = editor.current?.getModel(), next = latest.current;
    if (editable || !model || next === shown.current) return;
    if (next.startsWith(shown.current)) {
      const end = model.getFullModelRange().getEndPosition();
      model.applyEdits([{ range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text: next.slice(shown.current.length) }]);
    } else model.setValue(next);
    shown.current = next;
  }, [editable]);
  useEffect(() => { latest.current = text; sync(); }, [text, sync]);

  // (the editor: the version last saved, and the callbacks as of the last render)
  const clean = useRef(0), calls = useRef({ onDirty, onSave });
  useEffect(() => { calls.current = { onDirty, onSave }; });
  const report = useCallback(() => {
    const model = editor.current?.getModel();
    if (model) calls.current.onDirty?.(model.getAlternativeVersionId() !== clean.current);
  }, []);
  const saving = useRef(false);
  const save = useCallback(async () => {
    const model = editor.current?.getModel(), fn = calls.current.onSave;
    if (!model || !fn || saving.current) return;
    saving.current = true;
    try {
      // (what is typed while it saves stays unsaved)
      const version = model.getAlternativeVersionId();
      if (await fn(model.getValue())) { clean.current = version; report(); }
    } finally {
      saving.current = false;
    }
  }, [report]);

  return (
    <Editor
      height="100%"
      theme="vs-dark"
      language={languageOf(name)}
      defaultValue={editable ? text : undefined}
      onMount={(ed) => {
        editor.current = ed;
        if (!editable) { shown.current = ed.getValue(); sync(); return; }
        clean.current = ed.getModel()?.getAlternativeVersionId() ?? 0;
        ed.onDidChangeModelContent(report);
        ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
        onReady?.({ save: () => void save() });
      }}
      options={{ readOnly: !editable, domReadOnly: !editable, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, wordWrap: "on", renderWhitespace: "none" }}
    />
  );
}
