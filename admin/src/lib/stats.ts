import "server-only";

import { promises as fs } from "node:fs";

const STATS_FILE = process.env.STATS_FILE ?? "/run/genie/stats.jsonl";

export type SystemStats = {
  cpuPercent: number;
  memPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskPercent: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  ts: number;
};

export type ProcessInfo = {
  pid: number;
  ppid: number;
  user: string;
  cpu: number; // percent
  mem: number; // MB (resident)
  name: string;
  port: string; // "" when the process isn't a listener
};

export type ProcessSnapshot = {
  processes: ProcessInfo[];
  openPorts: number[];
  externalPorts: number[];
  ts: number;
};

type RawRecord = {
  ts: number;
  stats: {
    cpuPercent: number;
    memPercent: number;
    memUsedBytes: number;
    memTotalBytes: number;
    diskPercent: number;
    diskUsedBytes: number;
    diskTotalBytes: number;
    processes?: ProcessInfo[];
    openPorts?: number[];
    externalPorts?: number[];
  };
};

/**
 * The genie `vps-stats` daemon appends one JSON object per line to STATS_FILE
 * every few seconds. Read only the tail of the (ever-growing) file and return
 * the most recent fully-parseable record.
 */
async function readLatestRecord(): Promise<RawRecord | null> {
  let handle;
  try {
    handle = await fs.open(STATS_FILE, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return null;
    // Processes make each line large; read a generous tail slice.
    const readSize = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(readSize);
    await handle.read(buf, 0, readSize, size - readSize);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]) as RawRecord;
        if (obj?.stats && typeof obj.stats.cpuPercent === "number") return obj;
      } catch {
        // partial/corrupt line — keep scanning older lines
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** CPU/mem/disk summary for the top toolbar. */
export async function readLatestStats(): Promise<SystemStats | null> {
  const rec = await readLatestRecord();
  if (!rec) return null;
  const s = rec.stats;
  return {
    cpuPercent: s.cpuPercent,
    memPercent: s.memPercent,
    memUsedBytes: s.memUsedBytes,
    memTotalBytes: s.memTotalBytes,
    diskPercent: s.diskPercent,
    diskUsedBytes: s.diskUsedBytes,
    diskTotalBytes: s.diskTotalBytes,
    ts: rec.ts,
  };
}

/** Full process list with ports for the Processes page. */
export async function readLatestProcesses(): Promise<ProcessSnapshot | null> {
  const rec = await readLatestRecord();
  if (!rec) return null;
  return {
    processes: rec.stats.processes ?? [],
    openPorts: rec.stats.openPorts ?? [],
    externalPorts: rec.stats.externalPorts ?? [],
    ts: rec.ts,
  };
}
