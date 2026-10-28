// Review before push: the decisions, kept pure and in plain Node ESM so the git hook (scripts/review-hook.mjs) and the
// admin (src/lib/code-review) share them and the tests cover them. What a review is, where its settings and results
// live, and how the hook is installed: see src/lib/code-review/index.ts.

/** Severities, worst first. A setting's `blockAt` blocks a push with a finding this bad or worse. */
export const SEVERITIES = ["high", "medium", "low"];

/** The settings a repo starts with when review is turned on for it. */
export const DEFAULT_SETTINGS = {
  enabled: false,
  // which pushed branches are reviewed: globs, `*` within a segment and `**` across; "!pattern" leaves one out
  branches: ["main", "master"],
  // "high" | "medium" | "low": block at this severity or worse; "never": only warn
  blockAt: "high",
  // whose pushes: "both" | "agents" (Claude sessions) | "people"
  who: "both",
  // how hard Claude looks: "low" | "medium" | "high"
  effort: "medium",
  // files left out of the diff
  skip: ["package-lock.json", "**/package-lock.json", "*.lock", "**/*.lock", "pnpm-lock.yaml", "**/dist/**", "**/*.min.js", "**/*.map"],
  // past this the push goes through, with a note
  timeoutSec: 240,
};

export function withDefaults(s) {
  return { ...DEFAULT_SETTINGS, ...(s ?? {}) };
}

/** A glob as a RegExp: `**` any path, `*` within a segment, `?` one character. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // "**/" also matches nothing, so "**/x" matches "x"
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i++;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Whether a branch is reviewed: it matches a pattern and no "!pattern". No patterns: none. */
export function branchSelected(branch, patterns) {
  const ins = patterns.filter((p) => p && !p.startsWith("!"));
  const outs = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  return ins.some((p) => globToRegExp(p).test(branch)) && !outs.some((p) => globToRegExp(p).test(branch));
}

/** Whether this pusher is one the settings review: agents run in a Claude session (CLAUDECODE is set). */
export function pusherSelected(who, isAgent) {
  return who === "both" || (who === "agents" ? isAgent : !isAgent);
}

const ZERO = /^0+$/;

/**
 * git's pre-push stdin ("<local ref> <local sha> <remote ref> <remote sha>" a line) as the pushes to look at:
 * deletions dropped, the branch named from the remote ref. `remoteSha` is null for a new branch.
 */
export function parsePushLines(stdin) {
  const out = [];
  for (const line of stdin.split("\n")) {
    const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
    if (!localSha || !remoteRef || ZERO.test(localSha)) continue; // a deletion: nothing to review
    out.push({
      localRef,
      localSha,
      remoteRef,
      branch: remoteRef.replace(/^refs\/heads\//, ""),
      remoteSha: !remoteSha || ZERO.test(remoteSha) ? null : remoteSha,
    });
  }
  return out;
}

/** What a review's findings mean for the push under these settings: "blocked", "warned" or "passed". */
export function verdictFor(findings, blockAt) {
  if (!findings.length) return "passed";
  if (blockAt === "never") return "warned";
  const limit = SEVERITIES.indexOf(blockAt);
  return findings.some((f) => SEVERITIES.indexOf(f.severity) !== -1 && SEVERITIES.indexOf(f.severity) <= limit) ? "blocked" : "warned";
}

/** The structured answer asked of Claude. */
export const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: SEVERITIES },
          file: { type: "string" },
          line: { type: "integer" },
          title: { type: "string" },
          detail: { type: "string" },
        },
        required: ["severity", "file", "title", "detail"],
      },
    },
  },
  required: ["summary", "findings"],
};

/** The instructions for one review: the diff itself comes on stdin. */
export function reviewPrompt({ project, branch, commits, truncated }) {
  return [
    `You are reviewing a push to the branch "${branch}" of the project "${project}", before it leaves this server.`,
    `The commits: ${commits.map((c) => `"${c}"`).join(", ") || "(none listed)"}.`,
    "The full diff is on standard input. You can read the repository's files (Read, Grep, Glob) for context; the working tree may have moved on since these commits.",
    "Report only real defects a reviewer would block or flag: bugs, crashes, data loss, security holes, broken builds, leaked secrets, clear regressions. No style, naming or taste, no praise.",
    "Severity: high = it breaks something or is unsafe if it ships; medium = likely wrong in some case; low = worth a look.",
    "Give each finding the file and line in the new version, a one-line title and the concrete failure in the detail. An empty list is a fine answer.",
    truncated ? "The diff was cut short for size: say so in the summary, and don't guess about what you can't see." : "",
  ]
    .filter(Boolean)
    .join("\n");
}
