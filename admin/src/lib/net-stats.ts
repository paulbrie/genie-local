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
  /** a well-known name ("ssh", "http", …), else the process's name when it is readable without root, else the tech's, else "" */
  service: string;
  /** the listening process's name, null when it isn't readable (another user's process) */
  process: string | null;
  /** the addresses it listens on ("0.0.0.0", "::", "*", or an interface's own address) */
  addrs: string[];
  /** what serves it, told without root (T218); null when nothing names it */
  tech: PortTech | null;
};

/**
 * What serves a port (T218): `name` the technology ("nginx", "postgres", "ssh", "next", …), `via` how it was told,
 * the most specific first: a docker container's published port (its image), the listening process (ours only), a
 * systemd socket unit, an nginx site's `listen`, else the well-known port. `detail`: the container and image, the
 * unit, or the nginx sites.
 */
export type PortTech = { name: string; via: "docker" | "process" | "systemd" | "nginx" | "port"; detail?: string };

/** each source's names by "proto:port" ("tcp:5544") */
export type PortHints = { docker?: Map<string, PortTech>; systemd?: Map<string, PortTech>; nginx?: Map<string, PortTech> };

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

const portOf = (addr: string) => /:(\d+)$/.exec(addr)?.[1] ?? (/^\d+$/.test(addr) ? addr : null);

/** `systemctl list-sockets --all --show-types --no-legend --full`: the inet sockets' units ("tcp:22" → ssh, via ssh.socket) */
export function parseSystemdSockets(text: string): Map<string, PortTech> {
  const out = new Map<string, PortTech>();
  for (const line of text.split("\n")) {
    const [listen, type, unit] = line.trim().split(/\s+/);
    const port = listen && /^(?:\[[^\]]*\]|[\d.*]+):\d+$/.test(listen) ? portOf(listen) : null;
    const proto = type === "Stream" ? "tcp" : type === "Datagram" ? "udp" : null;
    if (!port || !proto || !unit?.endsWith(".socket")) continue;
    out.set(`${proto}:${port}`, { name: unit.replace(/\.socket$/, "").replace(/@.*$/, ""), via: "systemd", detail: unit });
  }
  return out;
}

/** an image's own name: "ghcr.io/remsky/kokoro-fastapi-cpu:latest" → "kokoro-fastapi-cpu", "postgres:16-alpine" → "postgres" */
const imageName = (image: string) => image.replace(/@.*$/, "").split("/").pop()!.replace(/:[^:]*$/, "");

/**
 * `docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'` (names, images and ports only): each published host port
 * ("0.0.0.0:5544->5432/tcp") named by its container's image.
 */
export function parseDockerPs(text: string): Map<string, PortTech> {
  const out = new Map<string, PortTech>();
  for (const line of text.split("\n")) {
    const [container, image, ports] = line.split("\t");
    if (!container || !image || !ports) continue;
    for (const p of ports.split(/,\s*/)) {
      const m = /:(\d+)(?:-(\d+))?->[\d-]+\/(tcp|udp)$/.exec(p.trim());
      if (!m) continue;
      const from = Number(m[1]), to = Math.min(Number(m[2] ?? m[1]), from + 100);
      for (let n = from; n <= to; n++) out.set(`${m[3]}:${n}`, { name: imageName(image), via: "docker", detail: `${container} · ${image}` });
    }
  }
  return out;
}

/** nginx's sites (each file's name and text): the ports their `listen` lines take, named nginx, the sites as the detail */
export function parseNginxListens(files: { name: string; text: string }[]): Map<string, PortTech> {
  const sites = new Map<string, string[]>();
  for (const f of files)
    for (const raw of f.text.split("\n")) {
      const m = /^\s*listen\s+([^\s;]+)([^;]*);/.exec(raw.replace(/#.*$/, ""));
      const port = m && portOf(m[1]);
      if (!port) continue;
      const key = `${/\bquic\b/.test(m[2]) ? "udp" : "tcp"}:${port}`;
      const names = sites.get(key) ?? [];
      if (!names.includes(f.name)) names.push(f.name);
      sites.set(key, names);
    }
  return new Map([...sites].map(([k, names]) => [k, { name: "nginx", via: "nginx", detail: names.join(", ") }]));
}

/** a process's name as a technology: "next-server (v1" (cut by the kernel) → "next" */
const processTech = (proc: string) => (/^next-server/.test(proc) ? "next" : proc.toLowerCase());

/**
 * The ports listening on a non-loopback address, from `ss -tulnpH`: one entry per port and protocol (IPv4 and
 * IPv6 merged), by port, each with what serves it (`hints`, T218). Loopback-only ports are left out.
 */
export function parseSs(text: string, hints: PortHints = {}): PublicPort[] {
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
    const e: PublicPort = byKey.get(key) ?? { port, proto, service: "", process: null, addrs: [], tech: null };
    const shown = addr.replace(/%.*$/, "");
    if (!e.addrs.includes(shown)) e.addrs.push(shown);
    e.process ??= proc;
    byKey.set(key, e);
  }
  for (const [key, e] of byKey) {
    const known = WELL_KNOWN[key];
    e.tech =
      hints.docker?.get(key) ??
      (e.process ? { name: processTech(e.process), via: "process" } : null) ??
      hints.systemd?.get(key) ??
      hints.nginx?.get(key) ??
      (known ? { name: known, via: "port" } : null);
    e.service = known ?? e.process ?? e.tech?.name ?? "";
  }
  return [...byKey.values()].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
}
