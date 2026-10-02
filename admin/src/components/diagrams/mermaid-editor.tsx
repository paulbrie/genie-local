"use client";

import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { StreamLanguage } from "@codemirror/language";
import { linter, lintGutter } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { useTheme } from "next-themes";

/**
 * Minimal Mermaid highlighter. Mermaid has no official CodeMirror language, so
 * this StreamLanguage tags the common tokens (comments, strings, diagram
 * keywords, edge operators) — enough for readable colouring without a grammar.
 */
const mermaidLanguage = StreamLanguage.define<unknown>({
  token(stream) {
    if (stream.match(/%%.*/)) return "comment";
    if (stream.match(/"[^"]*"/)) return "string";
    if (
      stream.match(
        /\b(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|C4Context|subgraph|end|participant|actor|note|loop|alt|opt|par|class|state|section|direction)\b/,
      )
    ) {
      return "keyword";
    }
    if (stream.match(/(-\.->|-->>|-->|->>|==>|===|---|:::|\|)/)) return "operator";
    stream.next();
    return null;
  },
});

/**
 * Async linter that runs the real Mermaid parser and surfaces the failure as an
 * inline diagnostic on the offending line (falling back to the whole doc when
 * the parser doesn't report a line).
 */
const mermaidLinter = linter(async (view) => {
  const code = view.state.doc.toString();
  if (!code.trim()) return [];
  try {
    // Only parse here — never initialize/render. The preview (MermaidView)
    // owns mermaid's config; a second writer on the shared singleton is what
    // made the live preview intermittently blank.
    const mermaid = (await import("mermaid")).default;
    await mermaid.parse(code);
    return [];
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const m = /line (\d+)/i.exec(message);
    const doc = view.state.doc;
    if (m) {
      const lineNo = Math.min(doc.lines, Math.max(1, Number(m[1])));
      const line = doc.line(lineNo);
      return [{ from: line.from, to: line.to, severity: "error", message }];
    }
    return [{ from: 0, to: doc.length, severity: "error", message }];
  }
});

type Props = {
  value: string;
  onChange: (v: string) => void;
};

/** Mermaid source editor: CodeMirror + highlighting + live parse diagnostics. */
export function MermaidEditor({ value, onChange }: Props) {
  const { resolvedTheme } = useTheme();
  const extensions = useMemo(
    () => [
      mermaidLanguage,
      mermaidLinter,
      lintGutter(),
      EditorView.lineWrapping,
    ],
    [],
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      height="100%"
      className="h-full text-xs [&_.cm-editor]:h-full [&_.cm-editor]:rounded-md [&_.cm-editor]:border [&_.cm-focused]:outline-none [&_.cm-gutters]:rounded-l-md"
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: true,
        autocompletion: false,
      }}
    />
  );
}
