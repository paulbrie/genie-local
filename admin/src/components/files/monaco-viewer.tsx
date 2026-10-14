"use client";

// A read-only Monaco for the file explorer's preview (T243), set up as the Ops view's code windows are (monaco from
// the package, its base worker bundled); highlighting only, so no language workers.
import { Editor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useCallback, useEffect, useRef } from "react";

loader.config({ monaco });
if (typeof self !== "undefined") {
  (self as unknown as { MonacoEnvironment?: object }).MonacoEnvironment ??= {
    getWorker: () => new Worker(new URL("../agents3d/ops/monaco/editor.worker.ts", import.meta.url), { type: "module" }),
  };
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

/**
 * `text` grows as the preview loads more pages: what is new is appended to the model (the view keeps its place), and
 * other text (another file) replaces it.
 */
export default function MonacoViewer({ name, text }: { name: string; text: string }) {
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const shown = useRef(""), latest = useRef("");
  const sync = useCallback(() => {
    const model = editor.current?.getModel(), next = latest.current;
    if (!model || next === shown.current) return;
    if (next.startsWith(shown.current)) {
      const end = model.getFullModelRange().getEndPosition();
      model.applyEdits([{ range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text: next.slice(shown.current.length) }]);
    } else model.setValue(next);
    shown.current = next;
  }, []);
  useEffect(() => { latest.current = text; sync(); }, [text, sync]);
  return (
    <Editor
      height="100%"
      theme="vs-dark"
      language={languageOf(name)}
      onMount={(ed) => { editor.current = ed; shown.current = ed.getValue(); sync(); }}
      options={{ readOnly: true, domReadOnly: true, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, wordWrap: "on", renderWhitespace: "none" }}
    />
  );
}
