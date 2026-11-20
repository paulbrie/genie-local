"use client";

import type { LiveReview, ReviewResult } from "@/lib/code-review";

/** How a push from the Git tab ended: what the route returned, and the review's result if one ran. */
export type PushEnd<T> = (T & { review?: ReviewResult | null; error?: undefined }) | { error: string; review?: ReviewResult | null };

/**
 * A push's answer (api/git/push, api/git/commit with push), read as it comes: JSON lines (code-review/push-stream.ts),
 * the review before push's progress to `onReview`, the last line the end; or, refused before it began, one JSON error.
 */
export async function readPush<T>(res: Response, onReview: (r: LiveReview) => void): Promise<PushEnd<T>> {
  if (!res.headers.get("Content-Type")?.includes("ndjson") || !res.body) {
    const j = (await res.json().catch(() => ({}))) as T & { error?: string };
    return !res.ok ? { error: j.error ?? `HTTP ${res.status}` } : (j as PushEnd<T>);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let end: PushEnd<T> | null = null;
  const take = (line: string) => {
    if (!line.trim()) return;
    const e = JSON.parse(line) as { type: string; review?: LiveReview | ReviewResult | null; error?: string };
    if (e.type === "review" && e.review) onReview(e.review as LiveReview);
    else if (e.type === "done") end = e as unknown as PushEnd<T>;
    else if (e.type === "error") end = { error: e.error ?? "the push failed", review: (e.review as ReviewResult | null) ?? null };
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) take(l);
  }
  take(buf);
  return end ?? { error: "the answer stopped short: look at the Git tab again" };
}
