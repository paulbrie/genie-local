import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inHiddenDir, withoutHiddenDirs } from "./hidden-dirs";

const files = [
  ".gitignore",
  ".env.example",
  "README.md",
  "src/app/page.tsx",
  "src/.eslintrc",
  ".next/server/app.js",
  ".claude/settings.json",
  "src/.cache/x/y.json",
  "packages/a/.turbo/log.txt",
].map((p) => ({ p, s: 1 }));

describe("inHiddenDir", () => {
  it("is true inside a folder whose name starts with a dot, at any depth", () => {
    for (const p of [".next/server/app.js", ".claude/settings.json", "src/.cache/x/y.json", "packages/a/.turbo/log.txt", ".git/HEAD"])
      assert.equal(inHiddenDir(p), true, p);
  });
  it("is false for dot-files in shown folders and for ordinary paths", () => {
    for (const p of [".gitignore", ".env.example", "src/.eslintrc", "README.md", "src/app/page.tsx", "a.b/c.ts", ""])
      assert.equal(inHiddenDir(p), false, p);
  });
});

describe("withoutHiddenDirs", () => {
  it("off (the default): hidden folders' files are left out, top-level and nested dot-files stay", () => {
    assert.deepEqual(
      withoutHiddenDirs(files, false).map((f) => f.p),
      [".gitignore", ".env.example", "README.md", "src/app/page.tsx", "src/.eslintrc"],
    );
  });
  it("on: everything, as given", () => {
    assert.equal(withoutHiddenDirs(files, true), files);
  });
});
