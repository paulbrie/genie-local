#!/usr/bin/env node
// Backfill the stats history (the admin's Server activity graph) from sysstat,
// which keeps CPU and memory every 10 minutes for weeks (/var/log/sysstat/saDD).
// Run it once on a box whose stats-history cron started late:
//
//   node /opt/project/admin/scripts/stats-history-import-sysstat.mjs
//
// Only samples older than the earliest point already in the history are added,
// so re-running never duplicates. sysstat doesn't record disk usage: imported
// points have no disk fields and the graph shows a gap there, not 0 %.
// Memory is total − available, as the live sampler measures it. Plain Node ESM
// + the `sadf` binary (sysstat); node built-ins only.

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const HISTORY_FILE =
  process.env.STATS_HISTORY_FILE ?? "/opt/project/.stats-history/history.jsonl";
const SYSSTAT_DIR = process.env.SYSSTAT_DIR ?? "/var/log/sysstat";
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function readHistory() {
  try {
    return await fs.readFile(HISTORY_FILE, "utf8");
  } catch {
    return "";
  }
}

function earliestT(raw) {
  let min = Infinity;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line).t;
      if (typeof t === "number" && t < min) min = t;
    } catch {
      /* skip a torn line */
    }
  }
  return min;
}

/** One sysstat daily file → compact history records (see stats-history.mjs). */
function readSysstatDay(file) {
  let json;
  try {
    json = JSON.parse(execFileSync("sadf", ["-j", file, "--", "-u", "-r"], { encoding: "utf8", maxBuffer: 64 << 20 }));
  } catch (err) {
    console.error(`skip ${file}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    return [];
  }
  const out = [];
  for (const s of json.sysstat?.hosts?.[0]?.statistics ?? []) {
    const ts = s.timestamp;
    const cpu = s["cpu-load"]?.find((c) => c.cpu === "all");
    const m = s.memory;
    if (!ts?.date || !ts.time || !cpu || !m || !m["memused-percent"]) continue;
    // sadf -j reports UTC (timestamp.utc = 1).
    const t = Date.parse(`${ts.date}T${ts.time}Z`);
    const totalKb = (m.memused * 100) / m["memused-percent"];
    const usedKb = totalKb - m.avail;
    out.push({
      t,
      cpu: Math.round(100 - cpu.idle),
      mem: Math.round((usedKb / totalKb) * 100),
      mu: Math.round(usedKb * 1024),
      mt: Math.round(totalKb * 1024),
      src: "sysstat",
    });
  }
  return out;
}

const before = earliestT(await readHistory());
const cutoff = Date.now() - RETENTION_MS;
const days = (await fs.readdir(SYSSTAT_DIR)).filter((f) => /^sa\d{2}$/.test(f)).sort();
const imported = days
  .flatMap((f) => readSysstatDay(path.join(SYSSTAT_DIR, f)))
  .filter((p) => p.t < before && p.t >= cutoff)
  .sort((a, b) => a.t - b.t);

if (imported.length === 0) {
  console.log("nothing to import (the history already starts before sysstat's data)");
  process.exit(0);
}

// Re-read right before the swap so a sample the cron appended meanwhile is kept.
const current = await readHistory();
const tmp = `${HISTORY_FILE}.import-${process.pid}`;
await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
await fs.writeFile(tmp, imported.map((p) => JSON.stringify(p)).join("\n") + "\n" + current);
await fs.rename(tmp, HISTORY_FILE);
console.log(
  `imported ${imported.length} sysstat samples, ${new Date(imported[0].t).toISOString()} → ${new Date(imported.at(-1).t).toISOString()}`,
);
