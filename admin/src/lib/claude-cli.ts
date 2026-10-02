import "server-only";

import { spawn } from "node:child_process";

/**
 * Run the server's already-authenticated Claude Code CLI headlessly and return
 * its result text. No API key — it uses the host's OAuth/subscription session
 * (~/.claude). Shared by the Jarvis narrator (/api/narrate) and Q&A (/api/ask).
 *
 * Notes that matter:
 *  - `stdio: ["ignore", …]` (stdin = /dev/null) is REQUIRED — without a TTY the
 *    CLI otherwise blocks waiting for piped stdin and the request hangs.
 *  - All tools are disallowed so a prompt can only produce text (never read files
 *    or run bash), and we run from a neutral cwd so no project CLAUDE.md is pulled
 *    into context.
 *  - SIGKILL on timeout so a wedged call can't pin the route open.
 */
export function runClaude(
  prompt: string,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--model",
        opts.model ?? "claude-haiku-4-5",
        "--output-format",
        "json",
        "--disallowed-tools",
        "Bash",
        "Edit",
        "Write",
        "Read",
        "Glob",
        "Grep",
        "WebFetch",
        "WebSearch",
        "Task",
        "NotebookEdit",
        "TodoWrite",
      ],
      {
        cwd: "/tmp",
        env: { ...process.env, HOME: process.env.HOME ?? "/home/genie" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("claude timed out"));
    }, opts.timeoutMs ?? 40_000);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(err.trim() || `claude exited ${code}`));
        return;
      }
      try {
        const env = JSON.parse(out) as { is_error?: boolean; result?: string };
        if (env.is_error || typeof env.result !== "string") {
          reject(new Error("claude returned an error"));
          return;
        }
        resolve(env.result);
      } catch (e) {
        reject(e as Error);
      }
    });
  });
}

/** Pull a JSON object out of possibly-fenced model text. Throws on no JSON. */
export function extractJson(raw: string): unknown {
  let t = raw.trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}
