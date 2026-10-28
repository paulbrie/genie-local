// The explorer's routes with the whole filesystem as its root (T243b): unreadable folders, kernel files, credential
// files shown only on request (logged by path, never by contents), uploads only where changes are allowed; saving an
// edited file (op "write"), and the explorer scoped to one project's folder (its Files tab).
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { EDIT_MAX } from "@/lib/files/edit";
import { GET as raw } from "./raw/route";
import { GET, POST } from "./route";
import { POST as startUpload } from "./upload/route";

let base: string, locked: string, w: string, projects: string;
const saved = { ...process.env };
const get = (q: string) => GET(new NextRequest(`http://localhost/api/files?${q}`));
const post = (body: object) => POST(new NextRequest("http://localhost/api/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const enc = encodeURIComponent;
const isRoot = process.getuid?.() === 0;

before(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "files-route-test-")));
  locked = path.join(base, "locked");
  await fs.mkdir(path.join(locked, "inside"), { recursive: true });
  await fs.chmod(locked, 0o000);
  w = path.join(base, "w");
  projects = path.join(base, "projects");
  await fs.mkdir(w);
  for (const d of ["p1/sub", "p2"]) await fs.mkdir(path.join(projects, d), { recursive: true });
  await fs.writeFile(path.join(projects, "p1", "sub", "f.txt"), "in p1\n");
  await fs.writeFile(path.join(projects, "p2", "g.txt"), "in p2\n");
  await fs.symlink(path.join(projects, "p2"), path.join(projects, "p1", "to-p2"));
  await fs.writeFile(path.join(base, ".env"), "API_KEY=do-not-log-me\n");
  process.env.ADMIN_FILES_ROOTS = "/";
  process.env.ADMIN_FILES_WRITE_ROOTS = `${w},${projects}`;
  process.env.PROJECTS_ROOT = projects;
  delete process.env.ADMIN_FILES_WRITE_EVERYWHERE;
});
after(async () => {
  for (const k of ["ADMIN_FILES_ROOTS", "ADMIN_FILES_WRITE_ROOTS", "PROJECTS_ROOT"]) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
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

describe("saving an edited file (op write)", () => {
  /** the file's first page, as the editor opens it */
  const open = async (p: string) => (await get(`op=read&path=${enc(p)}`)).json();

  it("opens a text file whole with its hash, saves it in place atomically, keeping its mode", async () => {
    const p = path.join(w, "a.txt");
    await fs.writeFile(p, "one\n");
    await fs.chmod(p, 0o640);
    const page = await open(p);
    assert.equal(page.editable, true);
    assert.equal(page.text, "one\n");
    assert.equal(page.next, page.size);
    assert.match(page.hash, /^[0-9a-f]{64}$/);

    const lines: string[] = [], log = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    let res: Response;
    try {
      res = await post({ op: "write", path: p, content: "two\nlines é\n", hash: page.hash });
    } finally {
      console.log = log;
    }
    assert.equal(res.status, 200);
    const saved = await res.json();
    assert.equal(await fs.readFile(p, "utf8"), "two\nlines é\n");
    assert.equal(saved.size, Buffer.byteLength("two\nlines é\n"));
    assert.equal(saved.hash, (await open(p)).hash);
    assert.equal((await fs.stat(p)).mode & 0o777, 0o640);
    assert.deepEqual((await fs.readdir(w)).filter((n) => n.endsWith(".save")), []);
    // (the audit line names the path and size, never the contents)
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[files\] write .*path=".*\/a\.txt" bytes=/);
    assert.ok(!lines[0].includes("lines"));

    // a second save from the new version works too
    assert.equal((await post({ op: "write", path: p, content: "three\n", hash: saved.hash })).status, 200);
    assert.equal(await fs.readFile(p, "utf8"), "three\n");
  });

  it("refuses a file changed on disk since it was read (409) and leaves it as it is", async () => {
    const p = path.join(w, "b.txt");
    await fs.writeFile(p, "mine\n");
    const { hash } = await open(p);
    await fs.writeFile(p, "someone else's\n");
    const res = await post({ op: "write", path: p, content: "mine, edited\n", hash });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /changed on disk/);
    assert.equal(await fs.readFile(p, "utf8"), "someone else's\n");
    // (no version at all: refused too)
    assert.equal((await post({ op: "write", path: p, content: "x" })).status, 400);
  });

  it("keeps credential, binary, non-UTF-8, too big and read-only files read-only", async () => {
    const cases: [string, string | Buffer, RegExp][] = [
      [path.join(w, ".env"), "TOKEN=x\n", /credential/],
      [path.join(w, "bin.dat"), Buffer.from([0x61, 0, 0x62]), /binary/],
      [path.join(w, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), /UTF-8/],
      [path.join(w, "big.txt"), "x".repeat(EDIT_MAX + 1), /too big/],
      [path.join(base, "outside.txt"), "not in a write root\n", /read-only here/],
    ];
    for (const [p, data, why] of cases) {
      await fs.writeFile(p, data);
      const before = await fs.readFile(p);
      const page = await get(`op=read&path=${enc(p)}&reveal=1`).then((r) => r.json());
      assert.equal(page.editable, undefined, p);
      assert.match(page.readOnly, why, p);
      const res = await post({ op: "write", path: p, content: "replaced", hash: "0".repeat(64) });
      assert.equal(res.status, 403, p);
      assert.match((await res.json()).error, why, p);
      assert.deepEqual(await fs.readFile(p), before, p);
    }
  });

  it("refuses content that is binary or too big, and paths outside the roots", async () => {
    const p = path.join(w, "c.txt");
    await fs.writeFile(p, "c\n");
    const { hash } = await open(p);
    assert.equal((await post({ op: "write", path: p, content: "a\0b", hash })).status, 400);
    assert.equal((await post({ op: "write", path: p, content: "y".repeat(EDIT_MAX + 1), hash })).status, 413);
    assert.equal((await post({ op: "write", path: p, content: 42, hash })).status, 400);
    assert.equal(await fs.readFile(p, "utf8"), "c\n");
    assert.equal((await post({ op: "write", path: path.join(w, "missing.txt"), content: "x", hash })).status, 404);
  });
});

describe("the explorer scoped to a project (its Files tab)", () => {
  const p1 = () => path.join(projects, "p1");

  it("has the project's folder as its only root, with nothing above it", async () => {
    const r = await (await get("op=roots&project=p1")).json();
    assert.deepEqual(r.roots, [p1()]);
    const l = await (await get(`op=list&project=p1&path=${enc(p1())}`)).json();
    assert.equal(l.root, p1());
    assert.equal(l.parent, null);
    assert.equal((await get(`op=list&project=p1&path=${enc(projects)}`)).status, 403);
    assert.equal((await get(`op=list&project=p1&path=${enc(path.join(p1(), ".."))}`)).status, 403);
    // (unscoped, the same folder has a parent as before)
    assert.equal((await (await get(`op=list&path=${enc(p1())}`)).json()).parent, projects);
  });

  it("refuses reads and changes outside the project, symlinks out included", async () => {
    const g = path.join(projects, "p2", "g.txt");
    assert.equal((await get(`op=read&project=p1&path=${enc(g)}`)).status, 403);
    assert.equal((await get(`op=read&project=p1&path=${enc(path.join(p1(), "to-p2", "g.txt"))}`)).status, 403);
    assert.equal((await raw(new NextRequest(`http://localhost/api/files/raw?project=p1&path=${enc(g)}&download=1`))).status, 403);
    const { hash } = await (await get(`op=read&path=${enc(g)}`)).json();
    assert.equal((await post({ op: "write", project: "p1", path: g, content: "x", hash })).status, 403);
    assert.equal((await post({ op: "mkdir", project: "p1", dir: path.join(projects, "p2"), name: "n" })).status, 403);
    assert.equal((await post({ op: "move", project: "p1", path: path.join(p1(), "sub", "f.txt"), to: path.join(projects, "p2") })).status, 403);
    for (const op of ["rename", "delete"]) assert.equal((await post({ op, project: "p1", path: p1(), name: "q" })).status, 403, op);
    assert.equal((await post({ op: "empty-trash", project: "p1" })).status, 403);
    const up = await startUpload(new NextRequest("http://localhost/api/files/upload", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: "p1", dir: path.join(projects, "p2"), name: "x.bin", size: 1 }),
    }));
    assert.equal(up.status, 403);
    assert.equal(await fs.readFile(g, "utf8"), "in p2\n");
    for (const bad of ["..", "../p2", ".hidden", "p1/sub"]) assert.equal((await get(`op=roots&project=${enc(bad)}`)).status, 400, bad);
  });

  it("edits a file inside the project", async () => {
    const f = path.join(p1(), "sub", "f.txt");
    const page = await (await get(`op=read&project=p1&path=${enc(f)}`)).json();
    assert.equal(page.editable, true);
    assert.equal((await post({ op: "write", project: "p1", path: f, content: "edited\n", hash: page.hash })).status, 200);
    assert.equal(await fs.readFile(f, "utf8"), "edited\n");
  });
});
