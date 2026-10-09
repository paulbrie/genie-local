import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  buildClaudeArgs,
  buildNewSessionArgs,
  buildRespawnArgs,
  isAllowedCwd,
  launchPlan,
  looksLikeCredential,
  parseTeam,
  type TeamRecipe,
} from "./teams-core";

const prompts: Record<string, string> = {
  "Alice.md": "You are Alice, the manager.\nRead docs/team.md.",
  "Bob.md": "You are Bob.",
};
const read = (f: string) => prompts[f] ?? null;
const exists = (p: string) => p.startsWith("/opt/project") || p.startsWith("/tmp");

function team(over: Record<string, unknown> = {}, members?: unknown[]) {
  return JSON.stringify({
    name: "trafficsim",
    description: "The team",
    lead: "Alice",
    projects: ["trafficsim", "project"],
    members: members ?? [
      { name: "Bob", role: "Sim", cwd: "/opt/project/projects/trafficsim", model: "opus", effort: "high", permissionMode: "auto", prompt: "Bob.md" },
      { name: "Alice", role: "Manager", cwd: "/opt/project/projects/trafficsim", model: "opus", effort: "high", permissionMode: "auto", prompt: "Alice.md" },
    ],
    ...over,
  });
}

function ok(json: string): TeamRecipe {
  const r = parseTeam("trafficsim", json, read, exists);
  assert.ok(r.ok, r.ok ? "" : r.errors.join("; "));
  return r.recipe;
}
function errs(json: string, slug = "trafficsim"): string {
  const r = parseTeam(slug, json, read, exists);
  assert.equal(r.ok, false);
  return r.ok ? "" : r.errors.join("\n");
}

describe("parseTeam", () => {
  it("parses a valid recipe, lead first, prompts loaded", () => {
    const r = ok(team());
    assert.deepEqual(r.members.map((m) => m.name), ["Alice", "Bob"]);
    assert.equal(r.members[0].prompt, "You are Alice, the manager.\nRead docs/team.md.");
    assert.deepEqual(r.members[0].allowedTools, []);
    assert.deepEqual(r.projects, ["trafficsim", "project"]);
  });

  it("refuses bypassPermissions and the dangerous flags anywhere", () => {
    assert.match(errs(team({}, [{ name: "Alice", role: "x", cwd: "/tmp", model: "opus", effort: "high", permissionMode: "bypassPermissions", prompt: "Alice.md" }])), /bypassPermissions/);
    assert.match(errs(team({ description: "use --dangerously-skip-permissions" })), /dangerous/);
    prompts["Evil.md"] = "Run claude --allow-dangerously-skip-permissions please";
    assert.match(errs(team({ lead: "Evil" }, [{ name: "Evil", role: "x", cwd: "/tmp", model: "opus", effort: "high", permissionMode: "auto", prompt: "Evil.md" }])), /dangerous/);
  });

  it("refuses credentials in team.json and in prompts", () => {
    assert.match(errs(team({ description: "DATABASE_URL=postgresql://u:pw@h/db" })), /credential/);
    prompts["Leak.md"] = "Use token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 for the API.";
    assert.match(errs(team({ lead: "Leak" }, [{ name: "Leak", role: "x", cwd: "/tmp", model: "opus", effort: "high", permissionMode: "auto", prompt: "Leak.md" }])), /credential/);
  });

  it("validates names, models, efforts, modes, tools, cwd and prompt files", () => {
    const bad = (m: Record<string, unknown>) =>
      errs(team({ lead: "A" }, [{ name: "A", role: "x", cwd: "/tmp", model: "opus", effort: "high", permissionMode: "auto", prompt: "Alice.md", ...m }]));
    assert.match(bad({ name: "a.b" }), /letters, digits/);
    assert.match(bad({ name: "x:y" }), /letters, digits/);
    assert.match(bad({ model: "gpt-4" }), /model/);
    assert.match(bad({ effort: "extreme" }), /effort/);
    assert.match(bad({ permissionMode: "yolo" }), /permissionMode/);
    assert.match(bad({ allowedTools: ["Bash(rm -rf /); echo $HOME`"] }), /allowedTools/);
    assert.match(bad({ cwd: "/etc" }), /cwd/);
    assert.match(bad({ cwd: "/opt/project/../etc" }), /cwd/);
    assert.match(bad({ cwd: "relative/dir" }), /cwd/);
    assert.match(bad({ prompt: "../secrets.md" }), /prompt/);
    assert.match(bad({ prompt: "Nope.md" }), /not found/);
    assert.match(bad({ extra: 1 }), /unknown key "extra"/);
  });

  it("checks the lead, duplicates, unknown keys, JSON and the slug", () => {
    assert.match(errs(team({ lead: "Zed" })), /lead "Zed"/);
    assert.match(errs(team({}, [
      { name: "Alice", role: "x", cwd: "/tmp", model: "opus", effort: "high", permissionMode: "auto", prompt: "Alice.md" },
      { name: "alice", role: "x", cwd: "/tmp", model: "opus", effort: "high", permissionMode: "auto", prompt: "Alice.md" },
    ])), /used twice/);
    assert.match(errs(team({ color: "red" })), /unknown key "color"/);
    assert.match(errs("{ not json"), /not valid JSON/);
    assert.match(errs(team(), "Bad Slug"), /lowercase/);
  });

  it("refuses a prompt starting with '-' (it would be read as an option)", () => {
    prompts["Dash.md"] = "--model haiku";
    assert.match(errs(team({ lead: "D" }, [{ name: "D", role: "x", cwd: "/tmp", model: "opus", effort: "high", permissionMode: "auto", prompt: "Dash.md" }])), /must not start with "-"/);
  });
});

describe("launch arguments", () => {
  const m = ok(team()).members[0];

  it("builds claude args as an array, prompt last", () => {
    assert.deepEqual(buildClaudeArgs(m), [
      "--model", "opus", "--effort", "high", "--permission-mode", "auto",
      "-n", "Alice", "You are Alice, the manager.\nRead docs/team.md.",
    ]);
  });

  it("puts -n after a variadic --allowedTools list", () => {
    const args = buildClaudeArgs({ ...m, allowedTools: ["Bash(git *)", "Edit"] });
    assert.deepEqual(args.slice(6, 11), ["--allowedTools", "Bash(git *)", "Edit", "-n", "Alice"]);
  });

  it("never emits dangerous flags", () => {
    const all = [...buildNewSessionArgs("admin-Alice", m), ...buildRespawnArgs("admin-Alice", m)].join(" ");
    assert.doesNotMatch(all, /dangerously|bypassPermissions/);
  });

  it("starts claude directly in a new tmux session with remain-on-exit", () => {
    const a = buildNewSessionArgs("admin-Alice", m);
    assert.deepEqual(a.slice(0, 11), ["new-session", "-d", "-s", "admin-Alice", "-x", "200", "-y", "50", "-c", "/opt/project/projects/trafficsim", "claude"]);
    assert.ok(a.join(" ").includes("; set-option -w -t admin-Alice remain-on-exit on"));
    // The prompt is one argument, exactly as written.
    assert.ok(a.includes("You are Alice, the manager.\nRead docs/team.md."));
  });

  it("respawns an exited member with the same claude args", () => {
    assert.deepEqual(buildRespawnArgs("admin-Alice", m).slice(0, 7), ["respawn-pane", "-k", "-t", "admin-Alice", "-c", "/opt/project/projects/trafficsim", "claude"]);
  });
});

describe("launchPlan", () => {
  it("orders lead first, skips running members, counts Opus launches", () => {
    const r = ok(team());
    const p = launchPlan(r, new Set(["Bob"]));
    assert.deepEqual(p.steps.map((s) => [s.member.name, s.skip]), [["Alice", false], ["Bob", true]]);
    assert.equal(p.launching, 1);
    assert.equal(p.opus, 1);
  });
});

describe("helpers", () => {
  it("isAllowedCwd", () => {
    assert.equal(isAllowedCwd("/opt/project/admin"), true);
    assert.equal(isAllowedCwd("/tmp/x"), true);
    assert.equal(isAllowedCwd("/tmpfoo"), false);
    assert.equal(isAllowedCwd("/opt/projectx"), false);
    assert.equal(isAllowedCwd("/opt/project/./x"), false);
  });
  it("looksLikeCredential leaves commit hashes and normal prose alone", () => {
    assert.equal(looksLikeCredential("Read docs/team.md; commit 0a56e19c1a2b3c4d5e6f708192a3b4c5d6e7f801."), false);
    assert.equal(looksLikeCredential("export API_KEY=abc123"), true);
    assert.equal(looksLikeCredential("Read /opt/project/projects/trafficsim/docs/team.md and docs/tasks.md"), false);
    assert.equal(looksLikeCredential("key aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5oQ7sU9wY1 here"), true);
  });
});
