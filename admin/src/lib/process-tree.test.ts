import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { descendants, parseProcStatus, processForest, type TreeProc } from "./process-tree";

const proc = (pid: number, ppid: number, cpu: number | null = 0, name = `p${pid}`): TreeProc => ({ pid, ppid, user: "genie", cpu, mem: 10, name, port: "" });

describe("parseProcStatus", () => {
  it("reads the name, parent, real uid and resident memory", () => {
    const text = "Name:\tnext-server (v1\nUmask:\t0002\nState:\tS (sleeping)\nTgid:\t4242\nPid:\t4242\nPPid:\t4200\nUid:\t1000\t1000\t1000\t1000\nVmRSS:\t  524288 kB\n";
    assert.deepEqual(parseProcStatus(text), { name: "next-server (v1", ppid: 4200, uid: 1000, mem: 512 });
  });

  it("gives a kernel thread no memory, and nothing for what isn't a status", () => {
    assert.deepEqual(parseProcStatus("Name:\tkworker/0:1\nPPid:\t2\nUid:\t0\t0\t0\t0\n"), { name: "kworker/0:1", ppid: 2, uid: 0, mem: 0 });
    assert.equal(parseProcStatus(""), null);
    assert.equal(parseProcStatus("Name:\tx\nUid:\t0\n"), null);
  });
});

describe("processForest", () => {
  it("joins the busiest up by those above them, init's children the roots, the busiest's line first", () => {
    // 10 (systemd --user) ─ 20 (npm) ─ 30 (next-server, busiest) ─ 40 (a worker, busy)
    //                     └ 21 (idle, not in it)
    // 50 (dockerd, busy) under init
    const busy = [proc(30, 20, 50), proc(50, 1, 20), proc(40, 30, 5)];
    const others = [proc(20, 10, null), proc(10, 1, null), proc(21, 10, null)];
    const rows = processForest(busy, others);
    assert.deepEqual(rows.map((r) => [r.pid, r.depth, r.busy, r.kids]), [
      [10, 0, false, 1],
      [20, 1, false, 1],
      [30, 2, true, 1],
      [40, 3, true, 0],
      [50, 0, true, 0],
    ]);
  });

  it("orders siblings by the busiest under them", () => {
    const busy = [proc(3, 1, 9), proc(5, 4, 8), proc(2, 1, 1)];
    const rows = processForest(busy, [proc(4, 1, null)]);
    assert.deepEqual(rows.map((r) => r.pid), [3, 4, 5, 2]);
  });

  it("makes a root of one whose parent it doesn't know, and of init itself, alone", () => {
    const rows = processForest([proc(1, 0, 3), proc(7, 6, 2), proc(8, 1, 1)], []);
    assert.deepEqual(rows.map((r) => [r.pid, r.depth]), [[1, 0], [7, 0], [8, 0]]);
  });

  it("survives a loop of parents (a pid reused)", () => {
    const rows = processForest([proc(5, 6, 2)], [proc(6, 5, null)]);
    assert.deepEqual(rows.map((r) => [r.pid, r.depth]), [[6, 0], [5, 1]]);
  });
});

describe("descendants", () => {
  it("lists everything under a process, the deepest first and it last", () => {
    const procs = [proc(2, 1), proc(3, 2), proc(4, 3), proc(5, 2), proc(9, 1)];
    const out = descendants(2, procs);
    assert.equal(out.at(-1), 2);
    assert.deepEqual([...out].sort(), [2, 3, 4, 5]);
    assert.ok(out.indexOf(4) < out.indexOf(3), "a child before its parent");
    assert.deepEqual(descendants(9, procs), [9]);
  });
});
