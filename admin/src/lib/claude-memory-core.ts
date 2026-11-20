// Pure (tested): where Claude Code keeps its memory on this box (claude-memory.ts applies it).
//
// The box's managed Claude policy (/etc/claude-code/managed-settings.json, from the genie setup) denies Claude every
// read and write under ~/.claude, to keep it from the login token and the other sessions there; the default memory
// folders, ~/.claude/projects/<project>/memory, are under it, so no session could keep a memory. The CLI takes the
// base of those folders from CLAUDE_CODE_REMOTE_MEMORY_DIR instead when it's set (<base>/projects/<project>/memory,
// the project folders named as under ~/.claude), so the admin sets it in the user's Claude settings, where every
// session reads it (a terminal's, an SSH one, an agent's), and the lock stays as it is.

/** The variable the Claude CLI reads as the base of its memory folders, in place of ~/.claude. */
export const MEMORY_ENV = "CLAUDE_CODE_REMOTE_MEMORY_DIR";

/**
 * ~/.claude/settings.json (its text; null: there is none) with env[MEMORY_ENV] set to `base`, and the base the
 * sessions will use. One set already is kept, whatever it names (someone chose it; ~/.claude itself puts the memory
 * back there). A file that isn't a JSON object is left alone: `error`.
 */
export function withMemoryEnv(text: string | null, base: string): { text: string; changed: boolean; base: string } | { error: string } {
  let settings: Record<string, unknown> = {};
  if (text !== null && text.trim()) {
    try {
      settings = JSON.parse(text);
    } catch {
      return { error: "it isn't valid JSON" };
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { error: "it isn't a JSON object" };
  }
  const env = settings.env ?? {};
  if (typeof env !== "object" || env === null || Array.isArray(env)) return { error: "its env isn't an object" };
  const current = (env as Record<string, unknown>)[MEMORY_ENV];
  if (typeof current === "string" && current.trim()) return { text: text ?? "", changed: false, base: current };
  const next = { ...settings, env: { ...env, [MEMORY_ENV]: base } };
  return { text: `${JSON.stringify(next, null, 2)}\n`, changed: true, base };
}
