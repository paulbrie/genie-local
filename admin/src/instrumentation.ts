/**
 * Runs once when a server instance starts (Next's instrumentation hook), in the
 * same process as the app: that is where the Slack bot lives, so it can use the
 * terminal and task code directly (src/lib/slack/bot.ts).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Not while building, and only on prod by default: admin-dev reads the same
  // .env.local, and two sockets for one Slack app would split its events between them.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NODE_ENV !== "production" && process.env.SLACK_ON_DEV !== "1") return;
  const { startSlackBot } = await import("./lib/slack/bot");
  // Don't hold up the server: the bot signs in and connects on its own.
  void startSlackBot();
}
