"use client";

import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { StreamLanguage } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { useTheme } from "next-themes";

/**
 * Minimal Nginx highlighter. There is no first-party CodeMirror grammar for the
 * Nginx config language, so this StreamLanguage tags the pieces that matter for
 * readability — comments, quoted strings, variables ($host), block braces and
 * statement semicolons, and the leading directive keyword on each statement.
 */
const nginxLanguage = StreamLanguage.define<{ start: boolean }>({
  startState: () => ({ start: true }),
  token(stream, state) {
    if (stream.eatSpace()) return null;
    if (stream.match(/#.*/)) return "comment";
    if (stream.match(/"(?:[^"\\]|\\.)*"/) || stream.match(/'(?:[^'\\]|\\.)*'/))
      return "string";
    if (stream.match(/\$[A-Za-z0-9_]+/)) return "variableName";
    if (stream.match(/[{};]/)) {
      // The next non-space token starts a new statement → directive position.
      state.start = true;
      return "punctuation";
    }
    // First bareword of a statement is the directive; the rest are arguments.
    if (stream.match(/[A-Za-z0-9_./:~^*=@+-]+/)) {
      const wasStart = state.start;
      state.start = false;
      return wasStart ? "keyword" : null;
    }
    stream.next();
    return null;
  },
});

type Props = {
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
};

/** Nginx config editor: CodeMirror + light syntax highlighting. */
export function NginxEditor({ value, onChange, readOnly }: Props) {
  const { resolvedTheme } = useTheme();
  const extensions = useMemo(
    () => [nginxLanguage, EditorView.lineWrapping],
    [],
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      extensions={extensions}
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      height="100%"
      className="h-full text-xs [&_.cm-editor]:h-full [&_.cm-editor]:rounded-md [&_.cm-editor]:border [&_.cm-focused]:outline-none [&_.cm-gutters]:rounded-l-md"
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: !readOnly,
        autocompletion: false,
      }}
    />
  );
}
