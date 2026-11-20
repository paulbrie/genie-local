import "server-only";

import { liveReviews, pushReview, type LiveReview, type ReviewResult } from "@/lib/code-review";

/** A line of a push's answer (NDJSON): see pushStream. */
export type PushEvent<T> =
  | { type: "review"; review: LiveReview }
  | { type: "tick" }
  | ({ type: "done"; review: ReviewResult | null } & T)
  | { type: "error"; error: string; review: ReviewResult | null };

/**
 * A push from the Git tab (`work`, which says through `watch` which checkout and branch it pushes once it knows),
 * answered as it goes, a JSON line at a time: `review` each time the review before push changes (its progress, from
 * the hook's live file), `tick` every 10 s otherwise (nginx gives up on a quiet answer after 300 s, and a review can
 * take longer), and last `done` with what `work` returned or `error`, either with the review's result if one ran.
 */
export function pushStream<T extends object>(work: (watch: (dir: string, branch: string) => void) => Promise<T>): Response {
  const since = new Date().toISOString();
  let target: { dir: string; branch: string } | null = null;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (e: PushEvent<T>) => {
        if (!closed) controller.enqueue(enc.encode(`${JSON.stringify(e)}\n`));
      };
      let last = "";
      let quiet = 0;
      let looking = false;
      const timer = setInterval(async () => {
        if (looking) return;
        looking = true;
        try {
          const t = target;
          const live = t ? (await liveReviews((r) => r.repo === t.dir && r.branch === t.branch && r.at >= since))[0] : undefined;
          const text = live ? JSON.stringify(live) : "";
          if (live && text !== last) {
            last = text;
            quiet = 0;
            send({ type: "review", review: live });
          } else if (++quiet >= 10) {
            quiet = 0;
            send({ type: "tick" });
          }
        } catch {
          /* the next look */
        } finally {
          looking = false;
        }
      }, 1000);
      const review = () => (target ? pushReview(target.dir, target.branch, since).catch(() => null) : Promise.resolve(null));
      try {
        const out = await work((dir, branch) => (target = { dir, branch }));
        clearInterval(timer);
        send({ type: "done", ...out, review: await review() });
      } catch (err) {
        clearInterval(timer);
        const r = await review();
        // (stopped by the review: its findings say why, better than git's lines)
        const error = r?.verdict === "blocked" ? "the review before push stopped it" : err instanceof Error ? err.message : String(err);
        send({ type: "error", error, review: r });
      } finally {
        closed = true;
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      // (as it goes: nothing between here and the browser holds it back, nginx nor compression)
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
