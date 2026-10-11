import "server-only";

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { cpus } from "node:os";
import { promisify } from "node:util";

import { NET_SAMPLES, parseNetDev, parseSs, publicIface, rateOf, type IfaceBytes, type NetSample, type NetStats, type PublicPort } from "@/lib/net-stats";
import { coreBusyPercent, parseProcStat, type CoreTimes } from "@/lib/proc-stat";

const execFileP = promisify(execFile);

const STATS_FILE = process.env.STATS_FILE ?? "/run/genie/stats.jsonl";

export type SystemStats = {
  cpuPercent: number;
  cpuCores: number;
  /** Busy % per core (cpu0…), since the previous request (≥ 1 s before); null on the first one or if unreadable. */
  cpuPerCore: number[] | null;
  memPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskPercent: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  /** bandwidth in/out on the public interface (T211); null if /proc/net is unreadable */
  net: NetStats | null;
  /** the ports listening on a non-loopback address (T211); null if `ss` failed */
  ports: PublicPort[] | null;
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

/**
 * Per-core busy %, read by the admin itself from /proc/stat (genie's collector
 * has the total only): each call is compared with the last reading kept here,
 * if it is at least 1 s old; a closer call gets the last result again.
 */
const PER_CORE_MIN_MS = 1000;
let lastCores: { at: number; cores: CoreTimes[] } | null = null;
let lastPerCore: number[] | null = null;

async function readPerCore(): Promise<number[] | null> {
  const now = Date.now();
  if (lastCores && now - lastCores.at < PER_CORE_MIN_MS) return lastPerCore;
  let cores: CoreTimes[];
  try {
    cores = parseProcStat(await fs.readFile("/proc/stat", "utf8"));
  } catch {
    return null;
  }
  lastPerCore = lastCores ? coreBusyPercent(lastCores.cores, cores) : null;
  lastCores = { at: now, cores };
  return lastPerCore;
}

/**
 * Bandwidth on the public interface (the default route's), read by the admin from /proc/net/dev when /api/stats is
 * read, at least NET_MIN_MS apart (a closer call gets the last result): the rate since the reading before, and the
 * last NET_SAMPLES of them.
 */
const NET_MIN_MS = 2000;
let lastNetRead: { t: number; iface: string; b: IfaceBytes } | null = null;
let netHistory: NetSample[] = [];
let lastNet: NetStats | null = null;

async function readNet(): Promise<NetStats | null> {
  const now = Date.now();
  if (lastNetRead && now - lastNetRead.t < NET_MIN_MS) return lastNet;
  let dev: Map<string, IfaceBytes>, route: string;
  try {
    [dev, route] = await Promise.all([fs.readFile("/proc/net/dev", "utf8").then(parseNetDev), fs.readFile("/proc/net/route", "utf8").catch(() => "")]);
  } catch {
    return null;
  }
  const iface = publicIface(route, dev);
  if (!iface) return null;
  const read = { t: now, iface, b: dev.get(iface)! };
  if (lastNetRead?.iface !== iface) netHistory = [];
  else netHistory = [...netHistory, rateOf(lastNetRead, read)].slice(-NET_SAMPLES);
  lastNetRead = read;
  const last = netHistory.at(-1);
  lastNet = { iface, inBps: last?.inBps ?? 0, outBps: last?.outBps ?? 0, history: netHistory };
  return lastNet;
}

/** The public ports, from `ss` (a fixed argv, no shell), kept PORTS_TTL_MS. */
const PORTS_TTL_MS = 5000;
let lastPorts: { at: number; ports: PublicPort[] | null } | null = null;

async function readPorts(): Promise<PublicPort[] | null> {
  const now = Date.now();
  if (lastPorts && now - lastPorts.at < PORTS_TTL_MS) return lastPorts.ports;
  let ports: PublicPort[] | null;
  try {
    const { stdout } = await execFileP("/usr/bin/ss", ["-tulnpH"], { timeout: 3000, maxBuffer: 1024 * 1024 });
    ports = parseSs(stdout);
  } catch {
    ports = null;
  }
  lastPorts = { at: now, ports };
  return ports;
}

/** CPU/mem/disk summary for the top toolbar, with the bandwidth and public ports for the Ops view's server rack. */
export async function readLatestStats(): Promise<SystemStats | null> {
  const [rec, cpuPerCore, net, ports] = await Promise.all([readLatestRecord(), readPerCore(), readNet(), readPorts()]);
  if (!rec) return null;
  const s = rec.stats;
  return {
    cpuPercent: s.cpuPercent,
    cpuPerCore,
    // The admin runs on the host it monitors, so the local core count matches
    // the CPU% being reported. Falls back to 0 on the rare empty cpus() result.
    cpuCores: cpus().length || 0,
    memPercent: s.memPercent,
    memUsedBytes: s.memUsedBytes,
    memTotalBytes: s.memTotalBytes,
    diskPercent: s.diskPercent,
    diskUsedBytes: s.diskUsedBytes,
    diskTotalBytes: s.diskTotalBytes,
    net,
    ports,
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
