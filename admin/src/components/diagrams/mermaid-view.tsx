"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTheme } from "next-themes";

type Props = {
  /** Mermaid source to render. */
  source: string;
  /** Debounce before (re-)rendering while the user types, in ms. */
  debounceMs?: number;
  /** Called with the rendered SVG markup on every successful render. */
  onRendered?: (svg: string) => void;
};

/**
 * Renders Mermaid source to SVG entirely client-side. Mermaid is imported
 * dynamically so it never runs during SSR, and re-renders (debounced) whenever
 * the source or the active theme changes. Parse errors are shown inline instead
 * of throwing, so a half-typed diagram doesn't blank the pane.
 */
export function MermaidView({ source, debounceMs = 250, onRendered }: Props) {
  const rawId = useId();
  // Mermaid needs a valid CSS/DOM id; useId() contains ':' which it rejects.
  const renderId = `mmd-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  // Guards against a stale async render overwriting a newer one.
  const runRef = useRef(0);

  useEffect(() => {
    const trimmed = source.trim();
    // Empty source renders the placeholder below; nothing to (re)render here.
    if (!trimmed) return;
    const run = ++runRef.current;
    const timer = setTimeout(async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: resolvedTheme === "dark" ? "dark" : "default",
        });
        // Unique id per render: mermaid injects a temp <div id=…>, so reusing
        // one id across overlapping renders can collide and blank the preview.
        const { svg: out } = await mermaid.render(`${renderId}-${run}`, trimmed);
        if (run !== runRef.current) return;
        setSvg(out);
        setError(null);
        onRendered?.(out);
      } catch (e) {
        if (run !== runRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    }, debounceMs);
    return () => clearTimeout(timer);
    // onRendered is intentionally excluded: callers pass an inline fn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, resolvedTheme, debounceMs, renderId]);

  if (!source.trim()) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Nothing to preview yet — write some Mermaid source.
      </p>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {error && (
        <pre className="mx-3 mt-3 shrink-0 overflow-auto rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs whitespace-pre-wrap text-destructive">
          {error}
        </pre>
      )}
      <div
        className="flex flex-1 items-center justify-center overflow-auto p-4 [&_svg]:max-w-full"
        // Rendered by Mermaid from user source under securityLevel: 'strict'
        // (scripts stripped, external links sandboxed).
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}
