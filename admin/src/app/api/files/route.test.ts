// The explorer's routes with the whole filesystem as its root (T243b): unreadable folders, kernel files, credential
// files shown only on request (logged by path, never by contents), uploads only where changes are allowed.
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { GET } from "./route";
import { POST as startUpload } from "./upload/route";

let base: string, locked: string;
const saved = { ...process.env };
const get = (q: string) => GET(new NextRequest(`http://localhost/api/files?${q}`));
const isRoot = process.getuid?.() === 0;

before(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "files-route-test-")));
  locked = path.join(base, "locked");
  await fs.mkdir(path.join(locked, "inside"), { recursive: true });
  await fs.chmod(locked, 0o000);
  await fs.mkdir(path.join(base, "w"));
  await fs.writeFile(path.join(base, ".env"), "API_KEY=do-not-log-me\n");
  process.env.ADMIN_FILES_ROOTS = "/";
  process.env.ADMIN_FILES_WRITE_ROOTS = path.join(base, "w");
  delete process.env.ADMIN_FILES_WRITE_EVERYWHERE;
});
after(async () => {
  for (const k of ["ADMIN_FILES_ROOTS", "ADMIN_FILES_WRITE_ROOTS"]) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  await fs.chmod(locked, 0o700);
  await fs.rm(base, { recursive: true, force: true });
});

describe("/api/files with / as its root (T243b)", () => {
  it("lists a folder it can't read as 'no permission', not an error", { skip: isRoot && "root reads everything" }, async () => {
    const res = await get(`op=list&path=${encodeURIComponent(locked)}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.noPermission, true);
    assert.deepEqual(body.entries, []);
    assert.equal((await (await get(`op=list&path=${encodeURIComponent(base)}`)).json()).noPermission, false);
  });

  it("lists /proc but doesn't read its files", async () => {
    assert.equal((await get("op=list&path=/proc")).status, 200);
    const res = await get("op=read&path=/proc/self/status");
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /kernel file/);
  });

  it("shows a credential file only on request, and logs its path, never its contents", async () => {
    const p = encodeURIComponent(path.join(base, ".env"));
    const hidden = await get(`op=read&path=${p}`);
    assert.equal(hidden.status, 403);
    const body = await hidden.json();
    assert.equal(body.secret, true);
    assert.ok(!JSON.stringify(body).includes("do-not-log-me"));

    const lines: string[] = [], log = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try {
      const shown = await get(`op=read&reveal=1&path=${p}`);
      assert.equal(shown.status, 200);
      assert.match((await shown.json()).text, /do-not-log-me/);
    } finally {
      console.log = log;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[files\] secret-viewed .*path=".*\/\.env"/);
    assert.ok(!lines[0].includes("do-not-log-me"));
  });

  it("starts an upload only where changes are allowed", async () => {
    const start = (dir: string) => startUpload(new NextRequest("http://localhost/api/files/upload", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir, name: "x.bin", size: 1 }),
    }));
    const refused = await start(base);
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /read-only here/);
  });
});
