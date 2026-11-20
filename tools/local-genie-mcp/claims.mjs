// Claims on tasks (claim_task, renew_task, release_task in server.mjs): which agent is working on a task, so two don't
// take the same one, and one whose agent went away frees up. Pure, tested (claims.test.mjs).
//
// A task's claim is its assignee. The assignee holds it while its admin terminal is open (an agent there never has to
// renew), or, past that, until `claimed_until` (the lease an agent outside the terminals keeps renewing; a claim from a
// terminal gets one too, so a terminal closed by mistake doesn't free its task at once). Past both, it's free again.

/** How long a claim's lease lasts unless asked otherwise, and the longest one, in minutes. */
export const LEASE_MINUTES = 30;
export const MAX_LEASE_MINUTES = 8 * 60;

/**
 * A task's claim as `me` sees it now: "done" (nothing to claim), "mine", "held" (someone else's: their terminal is
 * open, `live`, or their lease hasn't run out) or "free" (nobody's, or a claim that lapsed).
 */
export function claimState(task, me, live, now = Date.now()) {
  if (task.status === "done") return "done";
  if (!task.assignee) return "free";
  if (me && task.assignee === me) return "mine";
  if (live.has(task.assignee)) return "held";
  if (task.claimed_until && new Date(task.claimed_until).getTime() > now) return "held";
  return "free";
}

/**
 * The tasks `me` may claim next, in the order to try them: the open ones in the board's order, then the ones in
 * progress whose agent went away (their work half done: someone has to pick it up).
 */
export function claimable(tasks, me, live, now = Date.now()) {
  const free = tasks.filter((t) => claimState(t, me, live, now) === "free");
  return [...free.filter((t) => t.status === "open"), ...free.filter((t) => t.status !== "open")];
}

/** A lease asked for, in minutes, kept within 1 and MAX_LEASE_MINUTES (LEASE_MINUTES by default). */
export function leaseMinutes(asked) {
  if (asked === undefined || asked === null || !Number.isFinite(asked)) return LEASE_MINUTES;
  return Math.min(MAX_LEASE_MINUTES, Math.max(1, Math.round(asked)));
}
