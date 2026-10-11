/**
 * Network use and the public ports, for /api/stats (T211): pure parsing of /proc/net/route, /proc/net/dev and
 * `ss -tulnpH` (the reading itself, and the samples kept between requests, are in lib/stats.ts).
 */

/** One interface's byte counters since boot. */
export type IfaceBytes = { rx: number; tx: number };

/** bytes per second received (in) and sent (out) on the public interface, between two readings `t` (ms) */
export type NetSample = { t: number; inBps: number; outBps: number };

export type NetStats = {
  /** the interface measured: the default route's ("ens3") */
  iface: string;
  /** the latest rate (bytes/s); 0 before there are two readings */
  inBps: number;
  outBps: number;
  /** the last NET_SAMPLES rates, oldest first (for a sparkline) */
  history: NetSample[];
};

export type PublicPort = {
  port: number;
  proto: "tcp" | "udp";
  /** a well-known name ("ssh", "http", …), else the process's name when it is readable without root, else "" */
  service: string;
  /** the listening process's name, null when it isn't readable (another user's process) */
  process: string | null;
  /** the addresses it listens on ("0.0.0.0", "::", "*", or an interface's own address) */
  addrs: string[];
};

export const NET_SAMPLES = 60;

/** /proc/net/dev's counters per interface ("ens3" → its rx/tx bytes). */
export function parseNetDev(text: string): Map<string, IfaceBytes> {
  const out = new Map<string, IfaceBytes>();
  for (const line of text.split("\n")) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    // rx: bytes packets errs drop fifo frame compressed multicast; tx: bytes …
    if (v.length < 9 || !Number.isFinite(v[0]) || !Number.isFinite(v[8])) continue;
    out.set(m[1], { rx: v[0], tx: v[8] });
  }
  return out;
}

/** a virtual interface: loopback, docker's bridges and their veths, tunnels */
const VIRTUAL_RE = /^(?:lo|docker\d*|br-|veth|virbr|tun|tap|wg|tailscale|cni|flannel|cali|kube)/;

/** The default route's interface in /proc/net/route (the lowest metric, up); null if there is none. */
export function defaultIface(routeText: string): string | null {
  let best: { iface: string; metric: number } | null = null;
  for (const line of routeText.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || f[1] !== "00000000" || f[7] !== "00000000") continue;
    const flags = parseInt(f[3], 16), metric = Number(f[6]);
    if (!(flags & 1) || !Number.isFinite(metric)) continue;
    if (!best || metric < best.metric) best = { iface: f[0], metric };
  }
  return best?.iface ?? null;
}

/** The interface to measure: the default route's, else the busiest one that isn't virtual. */
export function publicIface(routeText: string, dev: Map<string, IfaceBytes>): string | null {
  const d = defaultIface(routeText);
  if (d && dev.has(d)) return d;
  let best: string | null = null;
  for (const [k, b] of dev) if (!VIRTUAL_RE.test(k) && (!best || b.rx + b.tx > dev.get(best)!.rx + dev.get(best)!.tx)) best = k;
  return best;
}

/** The rates between two readings (bytes/s); 0 when a counter went back (a reset, the interface re-created). */
export function rateOf(prev: { t: number; b: IfaceBytes }, next: { t: number; b: IfaceBytes }): NetSample {
  const dt = (next.t - prev.t) / 1000;
  const per = (a: number, b: number) => (dt > 0 && b >= a ? Math.round((b - a) / dt) : 0);
  return { t: next.t, inBps: per(prev.b.rx, next.b.rx), outBps: per(prev.b.tx, next.b.tx) };
}

const WELL_KNOWN: Record<string, string> = {
  "tcp:21": "ftp", "tcp:22": "ssh", "tcp:25": "smtp", "udp:53": "dns", "tcp:53": "dns", "udp:67": "dhcp", "udp:68": "dhcp",
  "tcp:80": "http", "udp:123": "ntp", "tcp:143": "imap", "tcp:443": "https", "udp:443": "https", "tcp:465": "smtps",
  "tcp:587": "smtp", "tcp:993": "imaps", "tcp:3306": "mysql", "tcp:5432": "postgres", "tcp:6379": "redis",
  "tcp:8080": "http-alt", "tcp:8443": "https-alt", "tcp:27017": "mongodb", "udp:51820": "wireguard",
};

/** a loopback address as ss prints it: 127.x, ::1, ::ffff:127.x, or bound to lo ("127.0.0.53%lo") */
function isLoopback(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, "");
  return /%lo$/.test(a) || /^127\./.test(a) || a === "::1" || /^::ffff:127\./i.test(a);
}

/**
 * The ports listening on a non-loopback address, from `ss -tulnpH`: one entry per port and protocol (IPv4 and
 * IPv6 merged), by port. Loopback-only ports are left out.
 */
export function parseSs(text: string): PublicPort[] {
  const byKey = new Map<string, PublicPort>();
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || (f[0] !== "tcp" && f[0] !== "udp")) continue;
    const m = /^(.*):(\d+)$/.exec(f[4]);
    if (!m) continue;
    const proto: PublicPort["proto"] = f[0], addr = m[1].replace(/^\[|\]$/g, ""), port = Number(m[2]);
    if (isLoopback(addr)) continue;
    // (a name is cut at 15 characters by the kernel: "next-server (v1" → "next-server")
    const proc = /users:\(\("([^"]+)"/.exec(line)?.[1].replace(/\s*\(.*$/, "") || null;
    const key = `${proto}:${port}`;
    const e = byKey.get(key) ?? { port, proto, service: "", process: null, addrs: [] };
    const shown = addr.replace(/%.*$/, "");
    if (!e.addrs.includes(shown)) e.addrs.push(shown);
    e.process ??= proc;
    byKey.set(key, e);
  }
  for (const e of byKey.values()) e.service = WELL_KNOWN[`${e.proto}:${e.port}`] ?? e.process ?? "";
  return [...byKey.values()].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
}
