import "server-only";

export type ValidateResult = {
  ok: boolean;
  /** Full parser message when invalid. */
  error?: string;
  /** 1-based line the parser flagged, when it reports one. */
  line?: number;
  /** e.g. "flowchart-v2", "sequence" — present when valid. */
  diagramType?: string;
};

/**
 * Validate Mermaid source with the real parser. `mermaid.parse()` runs the
 * grammar without needing a DOM, so this works in a plain Node route handler —
 * it returns the diagram type on success and throws a line-tagged error on
 * failure, which we normalise into a structured result.
 */
export async function validateMermaid(source: string): Promise<ValidateResult> {
  const src = source.trim();
  if (!src) return { ok: false, error: "Diagram source is empty" };
  const mermaid = (await import("mermaid")).default;
  try {
    const res = (await mermaid.parse(src)) as { diagramType?: string } | false;
    return { ok: true, diagramType: res ? res.diagramType : undefined };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const m = /line (\d+)/i.exec(error);
    return { ok: false, error, line: m ? Number(m[1]) : undefined };
  }
}
