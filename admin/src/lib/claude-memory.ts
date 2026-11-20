// Claude Code's memory, out of the locked ~/.claude (claude-memory-core.ts says why): run once as the admin starts
// (src/instrumentation.ts), so every instance gets it on its next deploy. No "server-only" import, so its test can
// run under node.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { withMemoryEnv } from "@/lib/claude-memory-core";

/**
 * Points the user's Claude sessions at `base` for their memory (~/.claude/settings.json's env; one set already is kept)
 * and copies each project's memory from ~/.claude over to it, once: a project with memory there already is left as it
 * is, and nothing in ~/.claude is touched but the settings. Sessions running now keep the old place until they restart.
 */
export async function ensureClaudeMemory(home = os.homedir(), base = path.join(home, "claude-memory")): Promise<{ base: string; set: boolean; copied: string[] }> {
  const file = path.join(home, ".claude", "settings.json");
  const text = await fs.readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  const next = withMemoryEnv(text, base);
  if ("error" in next) throw new Error(`${file} left as it is: ${next.error}`);
  if (next.changed) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const mode = text === null ? 0o644 : (await fs.stat(file)).mode & 0o777;
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, next.text, { mode });
    await fs.rename(tmp, file);
  }
  // (its own: memories are as private as the sessions that wrote them)
  await fs.mkdir(path.join(next.base, "projects"), { recursive: true, mode: 0o700 });
  await fs.chmod(next.base, 0o700).catch(() => {});

  const copied: string[] = [];
  const old = path.join(home, ".claude", "projects");
  if (path.resolve(next.base) !== path.join(home, ".claude")) {
    for (const project of await fs.readdir(old).catch(() => [] as string[])) {
      const from = path.join(old, project, "memory");
      const to = path.join(next.base, "projects", project, "memory");
      if (!(await fs.readdir(from).catch(() => [])).length) continue;
      if ((await fs.readdir(to).catch(() => [])).length) continue;
      await fs.cp(from, to, { recursive: true, force: false, errorOnExist: false });
      copied.push(project);
    }
  }
  return { base: next.base, set: next.changed, copied };
}
