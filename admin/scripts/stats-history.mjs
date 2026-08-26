#!/usr/bin/env node
// Persistent server-stats sampler (CPU / MEM / DISK).
//
// The genie `vps-stats` daemon writes a rich feed to /run/genie/stats.jsonl, but
// /run is tmpfs — wiped on reboot and not retained long-term. This script takes
// one compact snapshot and APPENDS it to a persistent history file so the admin
// can draw a 1d / 7d / 30d graph even when nobody has the UI open.
//
// Meant to be run from cron every minute:
//   * * * * * /usr/bin/node /opt/project/admin/scripts/stats-history.mjs
//
// It prefers the daemon's latest record (so the numbers match the top toolbar
// exactly); if that feed is missing/stale it self-measures from /proc + statfs,
// so history keeps flowing even if the daemon is down. Plain Node ESM, node
// built-ins only — it must run without the admin app's TS runtime.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const DAEMON_FILE = process.env.STATS_FILE ?? "/run/genie/stats.jsonl";
const HISTORY_FILE =
  process.env.STATS_HISTORY_FILE ?? "/opt/project/.stats-history/history.jsonl";

// How long to retain samples. We keep a day of slack past this so pruning
// (a full rewrite) happens at most ~once/day rather than every run.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_SLACK_MS = 24 * 60 * 60 * 1000;
// A daemon record older than this is treated as stale → self-measure instead.
const DAEMON_FRESH_MS = 60 * 1000;

/** Most recent fully-parseable daemon record, or null. Mirrors src/lib/stats.ts. */
async function readDaemonLatest() {
  let handle;
  try {
    handle = await fs.open(DAEMON_FILE, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return null;
    const readSize = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(readSize);
    await handle.read(buf, 0, readSize, size - readSize);
    const lines = buf
      .toString("utf8")
      .split("\n")
      .filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj?.stats && typeof obj.stats.cpuPercent === "number") return obj;
      } catch {
        /* partial/corrupt tail line — keep scanning */
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sum of busy/total CPU jiffies across all cores, from os.cpus(). */
function cpuTotals() {
  let busy = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    busy += t.user + t.nice + t.sys + t.irq;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { busy, total };
}

/** Self-measured snapshot when the daemon feed is unavailable/stale. */
async function selfMeasure() {
  const a = cpuTotals();
  await sleep(500);
  const b = cpuTotals();
  const dTotal = b.total - a.total;
  const cpuPercent = dTotal > 0 ? ((b.busy - a.busy) / dTotal) * 100 : 0;

  const memTotalBytes = os.totalmem();
  const memUsedBytes = memTotalBytes - os.freemem();

  let diskUsedBytes = 0;
  let diskTotalBytes = 0;
  try {
    const s = await fs.statfs("/");
    diskTotalBytes = s.blocks * s.bsize;
    diskUsedBytes = (s.blocks - s.bfree) * s.bsize;
  } catch {
    /* leave disk at 0 if statfs fails */
  }

  return {
    cpuPercent,
    memUsedBytes,
    memTotalBytes,
    memPercent: memTotalBytes ? (memUsedBytes / memTotalBytes) * 100 : 0,
    diskUsedBytes,
    diskTotalBytes,
    diskPercent: diskTotalBytes ? (diskUsedBytes / diskTotalBytes) * 100 : 0,
  };
}

/** One compact history point. Short keys keep 30 days of 1-min data small. */
function toPoint(ts, s) {
  const r1 = (n) => Math.round(n * 10) / 10; // 1 decimal for percentages
  return {
    t: ts,
    cpu: r1(s.cpuPercent),
    mem: r1(s.memPercent),
    disk: r1(s.diskPercent),
    mu: s.memUsedBytes,
    mt: s.memTotalBytes,
    du: s.diskUsedBytes,
    dt: s.diskTotalBytes,
  };
}

/** Drop samples older than retention — but only rewrite when we're past the
 *  slack window, so the common path is a cheap append, not a full rewrite. */
async function pruneIfStale(now) {
  let raw;
  try {
    raw = await fs.readFile(HISTORY_FILE, "utf8");
  } catch {
    return;
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return;
  let firstT = 0;
  try {
    firstT = JSON.parse(lines[0]).t ?? 0;
  } catch {
    /* ignore */
  }
  const hardCutoff = now - RETENTION_MS - PRUNE_SLACK_MS;
  if (firstT >= hardCutoff) return; // nothing old enough to bother rewriting

  const cutoff = now - RETENTION_MS;
  const kept = lines.filter((l) => {
    try {
      return (JSON.parse(l).t ?? 0) >= cutoff;
    } catch {
      return false;
    }
  });
  await fs.writeFile(HISTORY_FILE, kept.join("\n") + (kept.length ? "\n" : ""));
}

async function main() {
  const now = Date.now();
  const rec = await readDaemonLatest();
  const fresh = rec && typeof rec.ts === "number" && now - rec.ts < DAEMON_FRESH_MS;
  const stats = fresh ? rec.stats : await selfMeasure();
  const ts = fresh ? rec.ts : now;

  await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  await pruneIfStale(now);
  await fs.appendFile(HISTORY_FILE, JSON.stringify(toPoint(ts, stats)) + "\n");
}

main().catch((e) => {
  // A cron sampler must never spew — log to stderr and exit non-zero quietly.
  process.stderr.write(`stats-history: ${e?.message ?? e}\n`);
  process.exit(1);
});
