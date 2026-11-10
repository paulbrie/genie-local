/**
 * Runs once when a server instance starts (Next's instrumentation hook), in the
 * same process as the app: that is where the Slack bot lives, so it can use the
 * terminal and task code directly (src/lib/slack/bot.ts), and where production
 * problems on Vercel are collected (src/lib/vercel-collector.ts).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Not while building, and only on prod by default: admin-dev reads the same
  // .env.local, and two sockets for one Slack app would split its events between them.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  // Production problems on Vercel (each project's Vercel tab): listened for all the time, by the live admin only
  // (the dev instance shares the database, and would count every error twice).
  if (process.env.NODE_ENV === "production" || process.env.VERCEL_COLLECT_ON_DEV === "1") {
    const { startVercelCollector } = await import("./lib/vercel-collector");
    startVercelCollector();
  }
  if (process.env.NODE_ENV !== "production" && process.env.SLACK_ON_DEV !== "1") return;
  // Should ws ever be bundled again (next.config.ts), its bufferutil stub would break every frame the bot sends:
  // this makes ws skip bufferutil altogether. Read when ws loads, so before the import.
  process.env.WS_NO_BUFFER_UTIL ??= "1";
  const { startSlackBot } = await import("./lib/slack/bot");
  // Don't hold up the server: the bot signs in and connects on its own.
  void startSlackBot();
}
