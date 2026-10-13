import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { checkName, isWithin, resolveExisting, resolveNew } from "./guard";
import { isSecretPath, listDir, runningInside } from "./listing";
import { deletePath, makeFolder, movePath, planDelete, renamePath } from "./ops";
import { emptyTrash, listTrash, restoreFromTrash } from "./trash";
import { cancelUpload, CHUNK_BYTES, clearStale, completeUpload, getSession, startUpload, writeChunk } from "./uploads";

let base: string, root: string, outside: string, trash: string, uploads: string, runDir: string;
const roots = () => [root];
const bigDisk = async () => 1e15;

before(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "files-test-")));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  trash = path.join(root, ".trash");
  uploads = path.join(base, "uploads");
  runDir = path.join(base, "run");
  for (const d of [root, outside, uploads, runDir, path.join(root, "proj", ".git"), path.join(root, "docs")]) await fs.mkdir(d, { recursive: true });
  await fs.writeFile(path.join(root, "docs", "a.txt"), "hello");
  await fs.writeFile(path.join(outside, "secret.txt"), "nope");
  await fs.symlink(outside, path.join(root, "escape"));
  process.env.ADMIN_FILES_TRASH = trash;
});
after(async () => {
  delete process.env.ADMIN_FILES_TRASH;
  await fs.rm(base, { recursive: true, force: true });
});

describe("the path guard (T243)", () => {
  it("keeps every path inside a root: no .., no symlink leading out, nothing beside", async () => {
    assert.equal((await resolveExisting(path.join(root, "docs", "a.txt"), roots())).abs, path.join(root, "docs", "a.txt"));
    await assert.rejects(resolveExisting(path.join(root, "..", "outside", "secret.txt"), roots()), /outside/);
    await assert.rejects(resolveExisting(path.join(root, "escape", "secret.txt"), roots()), /outside/);
    await assert.rejects(resolveExisting(outside, roots()), /outside/);
    await assert.rejects(resolveExisting(path.join(root, "missing"), roots()), /not found/);
    await assert.rejects(resolveExisting("", roots()), /bad path/);
    assert.equal(isWithin(path.join(root, "x"), root), true);
    assert.equal(isWithin(`${root}-other`, root), false);
  });
  it("takes a new name as one plain segment, in a folder inside a root", async () => {
    for (const bad of ["", ".", "..", "a/b", "a\\b", "a\0b", "x".repeat(256)]) assert.throws(() => checkName(bad), /bad name/);
    assert.equal(checkName(" ok.txt "), "ok.txt");
    await assert.rejects(resolveNew(path.join(root, "docs"), "a.txt", roots()), /already exists/);
    await assert.rejects(resolveNew(path.join(root, "escape"), "x.txt", roots()), /outside/);
  });
  it("tells a credential or key by its name or folder", () => {
    for (const p of ["/x/.env", "/x/.env.local", "/x/key.pem", "/x/id_ed25519", "/home/u/.ssh/config", "/x/.npmrc", "/x/credentials.json", "/x/secrets.yaml"]) assert.equal(isSecretPath(p), true, p);
    for (const p of ["/x/env.ts", "/x/id_ed25519.pub", "/x/README.md", "/x/keys.ts"]) assert.equal(isSecretPath(p), false, p);
  });
});

describe("chunked uploads (T243)", () => {
  const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);
  it("writes chunks at their offsets, takes a retried chunk as there, refuses a gap with what it has, and renames into place", async () => {
    const final = path.join(root, "docs", "big.bin");
    const s = await startUpload(final, 25, false, uploads, bigDisk);
    assert.equal((await writeChunk(s.id, 0, bytes(10, 1), uploads)).received, 10);
    assert.equal((await writeChunk(s.id, 0, bytes(10, 1), uploads)).received, 10, "a retry of a chunk it has");
    await assert.rejects(writeChunk(s.id, 20, bytes(5, 3), uploads), (e: { status: number; received: number }) => e.status === 409 && e.received === 10);
    await assert.rejects(completeUpload(s.id, uploads), /incomplete: 10 of 25/);
    await writeChunk(s.id, 10, bytes(10, 2), uploads);
    await writeChunk(s.id, 20, bytes(5, 3), uploads);
    assert.deepEqual(await completeUpload(s.id, uploads), { path: final, size: 25 });
    assert.deepEqual([...(await fs.readFile(final))], [...bytes(10, 1), ...bytes(10, 2), ...bytes(5, 3)]);
    assert.equal((await fs.readdir(path.join(root, "docs"))).some((n) => n.endsWith(".part")), false, "no temp file left");
    await assert.rejects(getSession(s.id, uploads), /no such upload/);
  });
  it("refuses a chunk past the end or too big, a taken name unless overwriting, and a disk without room", async () => {
    const s = await startUpload(path.join(root, "docs", "two.bin"), 4, false, uploads, bigDisk);
    await assert.rejects(writeChunk(s.id, 0, bytes(5, 0), uploads), /past the file's end/);
    await assert.rejects(writeChunk(s.id, 0, new Uint8Array(CHUNK_BYTES + 1), uploads), /too big|past/);
    await assert.rejects(startUpload(path.join(root, "docs", "a.txt"), 3, false, uploads, bigDisk), /already there/);
    const over = await startUpload(path.join(root, "docs", "a.txt"), 3, true, uploads, bigDisk);
    await writeChunk(over.id, 0, new TextEncoder().encode("new"), uploads);
    await completeUpload(over.id, uploads);
    assert.equal(await fs.readFile(path.join(root, "docs", "a.txt"), "utf8"), "new");
    await assert.rejects(startUpload(path.join(root, "docs", "huge.bin"), 10, false, uploads, async () => 100), /not enough room/);
    await cancelUpload(s.id, uploads);
  });
  it("cancels (temp file and state gone), and clears sessions left for a day", async () => {
    const s = await startUpload(path.join(root, "docs", "c.bin"), 10, false, uploads, bigDisk);
    await cancelUpload(s.id, uploads);
    await assert.rejects(fs.stat(s.tmp));
    const old = await startUpload(path.join(root, "docs", "old.bin"), 10, false, uploads, bigDisk);
    assert.equal(await clearStale(uploads, Date.now() + 25 * 3600_000), 1);
    await assert.rejects(fs.stat(old.tmp));
  });
});

describe("new folder, rename, move, delete to the trash and restore (T243)", () => {
  it("makes, renames and moves inside the roots, never a root nor into itself", async () => {
    const d = await makeFolder(path.join(root, "docs"), "sub", roots());
    const r = await renamePath(d, "sub2", roots());
    assert.equal(path.basename(r), "sub2");
    const m = await movePath(r, root, roots());
    assert.equal(m, path.join(root, "sub2"));
    await assert.rejects(movePath(path.join(root, "docs"), path.join(root, "docs"), roots()), /already exists|into itself/);
    await assert.rejects(renamePath(root, "x", roots()), /root/);
    await assert.rejects(movePath(path.join(root, "sub2"), outside, roots()), /outside/);
  });
  it("refuses to delete a root, a .git folder, or anything in the trash; says what a folder holds", async () => {
    await assert.rejects(planDelete(root, roots()), /root/);
    await assert.rejects(planDelete(path.join(root, "proj", ".git"), roots()), /\.git/);
    const plan = await planDelete(path.join(root, "docs"), roots(), runDir);
    assert.equal(plan.type, "dir");
    assert.ok(plan.files >= 1 && plan.bytes >= 3);
  });
  it("moves to the trash, restores to where it was (refusing when something is there now), and empties", async () => {
    await fs.writeFile(path.join(root, "docs", "t.txt"), "trash me");
    const item = await deletePath(path.join(root, "docs", "t.txt"), false, roots(), runDir);
    await assert.rejects(fs.stat(path.join(root, "docs", "t.txt")));
    assert.deepEqual((await listTrash(trash)).map((i) => i.originalPath), [path.join(root, "docs", "t.txt")]);
    await assert.rejects(planDelete(path.join(trash, item.id), roots()), /in the trash/);
    await fs.writeFile(path.join(root, "docs", "t.txt"), "someone else");
    await assert.rejects(restoreFromTrash(item.id, trash), /something is at/);
    await fs.rm(path.join(root, "docs", "t.txt"));
    await restoreFromTrash(item.id, trash);
    assert.equal(await fs.readFile(path.join(root, "docs", "t.txt"), "utf8"), "trash me");
    await deletePath(path.join(root, "docs", "t.txt"), false, roots(), runDir);
    assert.deepEqual(await emptyTrash(trash), { items: 1, bytes: 8 });
    assert.deepEqual(await listTrash(trash), []);
  });
  it("asks for a second confirm when a process the admin runs works inside the folder", async () => {
    const work = path.join(root, "proj", "app");
    await fs.mkdir(work, { recursive: true });
    const child = spawn("sleep", ["5"], { cwd: work, stdio: "ignore" });
    try {
      await fs.writeFile(path.join(runDir, "proj-app-dev.pid"), String(child.pid));
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual((await runningInside(path.join(root, "proj"), runDir)).map((r) => r.slug), ["proj-app-dev"]);
      await assert.rejects(deletePath(path.join(root, "proj", "app"), false, roots(), runDir), /running inside it: proj-app-dev/);
      const item = await deletePath(path.join(root, "proj", "app"), true, roots(), runDir);
      assert.equal(item.type, "dir");
    } finally {
      child.kill();
    }
  });
  it("lists a folder, folders first", async () => {
    const names = (await listDir(root)).map((e) => `${e.type}:${e.name}`);
    assert.ok(names.indexOf("dir:docs") < names.indexOf("symlink:escape"));
  });
});

describe("the whole filesystem to read, a few places to change (T243b)", () => {
  const env = (k: string, v?: string) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  it("reads everywhere by default; changes only under /opt/project, /home/genie and /tmp unless writes everywhere is on", async () => {
    const { fileRoots, writeRoots } = await import("./guard");
    const saved = [process.env.ADMIN_FILES_ROOTS, process.env.ADMIN_FILES_WRITE_ROOTS, process.env.ADMIN_FILES_WRITE_EVERYWHERE];
    try {
      env("ADMIN_FILES_ROOTS"); env("ADMIN_FILES_WRITE_ROOTS"); env("ADMIN_FILES_WRITE_EVERYWHERE");
      assert.deepEqual(fileRoots(), ["/"]);
      assert.deepEqual(writeRoots(), ["/opt/project", "/home/genie", "/tmp"]);
      env("ADMIN_FILES_WRITE_EVERYWHERE", "1");
      assert.deepEqual(writeRoots(), ["/"]);
      env("ADMIN_FILES_WRITE_EVERYWHERE"); env("ADMIN_FILES_ROOTS", `${root}, ${outside}`);
      assert.deepEqual(fileRoots(), [root, outside]);
    } finally {
      env("ADMIN_FILES_ROOTS", saved[0]); env("ADMIN_FILES_WRITE_ROOTS", saved[1]); env("ADMIN_FILES_WRITE_EVERYWHERE", saved[2]);
    }
  });

  it("refuses changes outside the write roots, and to a write root itself; reading there still works", async () => {
    const { assertWritable } = await import("./guard");
    const wide = [root, outside], writes = [path.join(root, "proj")];
    await fs.writeFile(path.join(outside, "ro.txt"), "read me");
    await assertWritable(path.join(root, "proj", "x"), {}, writes);
    await assert.rejects(assertWritable(path.join(root, "docs"), {}, writes), /read-only here/);
    await assert.rejects(assertWritable(path.join(root, "proj"), { self: true }, writes), /itself can't be changed/);
    await assert.rejects(assertWritable("/etc/passwd", {}, ["/opt/project", "/home/genie", "/tmp"]), /read-only here/);

    await assert.rejects(makeFolder(outside, "new", wide, writes), /read-only here/);
    await assert.rejects(renamePath(path.join(outside, "ro.txt"), "rw.txt", wide, writes), /read-only here/);
    await assert.rejects(movePath(path.join(outside, "ro.txt"), path.join(root, "proj"), wide, writes), /read-only here/);
    await assert.rejects(movePath(path.join(root, "proj", ".git"), outside, wide, writes), /read-only here/);
    await assert.rejects(planDelete(path.join(outside, "ro.txt"), wide, runDir, writes), /read-only here/);
    await assert.rejects(deletePath(path.join(outside, "ro.txt"), true, wide, runDir, writes), /read-only here/);
    await assert.rejects(deletePath(path.join(root, "proj"), true, wide, runDir, writes), /itself can't be changed/);
    assert.equal(await fs.readFile(path.join(outside, "ro.txt"), "utf8"), "read me");
    assert.equal((await resolveExisting(path.join(outside, "ro.txt"), wide)).abs, path.join(outside, "ro.txt"));

    const made = await makeFolder(path.join(root, "proj"), "ok", wide, writes);
    assert.equal(made, path.join(root, "proj", "ok"));
    await fs.rmdir(made);
  });

  it("knows the kernel's pseudo-filesystems", async () => {
    const { isPseudo } = await import("./guard");
    for (const p of ["/proc", "/proc/1/environ", "/sys/kernel"]) assert.ok(isPseudo(p), p);
    for (const p of ["/", "/process", "/system", "/opt/project/proc"]) assert.ok(!isPseudo(p), p);
  });
});
