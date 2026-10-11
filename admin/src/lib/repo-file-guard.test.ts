import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { contentRefusal, MAX_BYTES, nameRefusal, readRepoFile } from "./repo-file-guard";

const dir = mkdtempSync(path.join(tmpdir(), "t197-")), repo = path.join(dir, "repo"), outside = path.join(dir, "outside");
mkdirSync(path.join(repo, "src"), { recursive: true });
mkdirSync(outside);
const put = (rel: string, body: string | Buffer, root = repo) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), body); };
put("src/a.ts", "export const a = 1;\n");
put(".env", "X=1\n");
put("src/.env.local", "X=1\n");
put("deploy/server.pem", "x\n");
put("keys/id_ed25519", "x\n");
put(".ssh/config", "Host x\n");
put("big.txt", Buffer.alloc(MAX_BYTES + 10, 97));
put("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
put("src/db.ts", `const u = "postgres://app:hunter22@db:5432/x";\n`);
put("src/conf.ts", "API_KEY = abcdef123456\n");
put("src/k.ts", "-----BEGIN OPENSSH PRIVATE KEY-----\n");
put("secret.txt", "the outside world\n", outside);
symlinkSync(path.join(outside, "secret.txt"), path.join(repo, "src/link.txt"));
symlinkSync(path.join(repo, ".env"), path.join(repo, "src/env-link.txt"));
const shown = new Set(["src/a.ts", ".env", "src/.env.local", "deploy/server.pem", "keys/id_ed25519", ".ssh/config", "big.txt", "logo.png", "src/db.ts", "src/conf.ts", "src/k.ts", "src/link.txt", "src/env-link.txt", "../outside/secret.txt"]);
after(() => rmSync(dir, { recursive: true, force: true }));

describe("repo file guard (T197)", () => {
  it("reads a file the map shows, inside its repo", async () => {
    const r = await readRepoFile(repo, "src/a.ts", shown);
    assert.ok(r.ok && r.text === "export const a = 1;\n");
  });
  it("refuses a file the map doesn't show, or a repo it doesn't show", async () => {
    put("src/hidden.ts", "x\n");
    assert.deepEqual(await readRepoFile(repo, "src/hidden.ts", shown), { ok: false, status: 404, error: "Not a file on the map." });
    assert.equal((await readRepoFile(repo, "src/a.ts", undefined)).ok, false);
  });
  it("refuses .. and absolute paths, and symlinks out of the repo or onto a secret", async () => {
    for (const rel of ["../outside/secret.txt", "src/../../outside/secret.txt", "/etc/passwd"]) assert.equal((await readRepoFile(repo, rel, shown)).ok, false, rel);
    const out = await readRepoFile(repo, "src/link.txt", shown);
    assert.ok(!out.ok && /outside the repo/.test(out.error));
    const env = await readRepoFile(repo, "src/env-link.txt", shown);
    assert.ok(!env.ok && /secrets/.test(env.error));
  });
  it("refuses secrets by name: .env*, keys, credentials, secret folders", async () => {
    for (const rel of [".env", "src/.env.local", "deploy/server.pem", "keys/id_ed25519", ".ssh/config"]) {
      const r = await readRepoFile(repo, rel, shown);
      assert.ok(!r.ok && r.status === 403, rel);
    }
    for (const rel of ["credentials.md", "x/.git-credentials", ".netrc", ".npmrc", "a/b/secrets.yaml", "agent-browser-state.json", "tls.key"]) assert.ok(nameRefusal(rel), rel);
    for (const rel of ["src/env.ts", "src/keys.ts", "docs/credentials-howto.txt.bak", "README.md"]) assert.equal(nameRefusal(rel), null, rel);
  });
  it("refuses big files, binaries, and what the secrets hook stops", async () => {
    assert.equal((await readRepoFile(repo, "big.txt", shown)).ok, false);
    const png = await readRepoFile(repo, "logo.png", shown);
    assert.ok(!png.ok && png.status === 415);
    for (const rel of ["src/db.ts", "src/conf.ts", "src/k.ts"]) {
      const r = await readRepoFile(repo, rel, shown);
      assert.ok(!r.ok && r.status === 403 && /looks like/.test(r.error), rel);
    }
    assert.equal(contentRefusal(Buffer.from("const password = getPassword();\n")), null, "code about passwords is fine");
  });
});
