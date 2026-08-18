import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
function readCpuSample() {
    const raw = fs.readFileSync("/proc/stat", "utf8");
    const line = raw.split("\n").find((l) => l.startsWith("cpu "));
    if (!line)
        return null;
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    if (parts.some((n) => Number.isNaN(n)))
        return null;
    const total = parts.reduce((a, b) => a + b, 0);
    const idle = parts[3] + parts[4];
    return { total, idle };
}
function cpuPercentFromSamples(prev, curr) {
    if (!prev)
        return 0;
    const dTotal = curr.total - prev.total;
    const dIdle = curr.idle - prev.idle;
    return dTotal > 0 ? Math.round(((dTotal - dIdle) / dTotal) * 100) : 0;
}
function readMemory() {
    const raw = fs.readFileSync("/proc/meminfo", "utf8");
    const totalMatch = raw.match(/MemTotal:\s+(\d+)\s+kB/);
    const availMatch = raw.match(/MemAvailable:\s+(\d+)\s+kB/);
    const memTotalBytes = totalMatch ? parseInt(totalMatch[1], 10) * 1024 : 0;
    const availBytes = availMatch ? parseInt(availMatch[1], 10) * 1024 : 0;
    const memUsedBytes = memTotalBytes - availBytes;
    const memPercent = memTotalBytes > 0 ? Math.round((memUsedBytes / memTotalBytes) * 100) : 0;
    return { memUsedBytes, memTotalBytes, memPercent };
}
async function readDisk() {
    try {
        const { stdout } = await execFileAsync("df", ["-B1", "/"], { maxBuffer: 64 * 1024 });
        const line = stdout.trim().split("\n").pop() ?? "";
        const parts = line.split(/\s+/);
        if (parts.length < 4)
            return { diskUsedBytes: 0, diskTotalBytes: 0, diskPercent: 0 };
        const diskTotalBytes = parseInt(parts[1], 10) || 0;
        const diskUsedBytes = parseInt(parts[2], 10) || 0;
        const diskPercent = diskTotalBytes > 0 ? Math.round((diskUsedBytes / diskTotalBytes) * 100) : 0;
        return { diskUsedBytes, diskTotalBytes, diskPercent };
    }
    catch {
        return { diskUsedBytes: 0, diskTotalBytes: 0, diskPercent: 0 };
    }
}
async function readProcessesAndPorts() {
    const pidPortMap = new Map();
    const externalPortSet = new Set();
    const allPortSet = new Set();
    try {
        const { stdout: ssOut } = await execFileAsync("ss", ["-tlnp"], { maxBuffer: 512 * 1024 });
        for (const line of ssOut.trim().split("\n")) {
            const cols = line.trim().split(/\s+/);
            if (cols.length < 5)
                continue;
            const localAddr = cols[3];
            const portMatch = localAddr.match(/:(\d+)$/);
            const pidMatch = line.match(/pid=(\d+)/);
            if (portMatch) {
                const port = parseInt(portMatch[1], 10);
                allPortSet.add(port);
                const isExternal = localAddr.startsWith("0.0.0.0:") ||
                    localAddr.startsWith("*:") ||
                    localAddr.startsWith("[::]:") ||
                    localAddr.startsWith(":::");
                if (isExternal)
                    externalPortSet.add(port);
                if (pidMatch) {
                    const pid = parseInt(pidMatch[1], 10);
                    const existing = pidPortMap.get(pid);
                    pidPortMap.set(pid, existing ? `${existing},${port}` : String(port));
                }
            }
        }
    }
    catch {
        // ss may be missing or require privileges
    }
    const processes = [];
    try {
        const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid=,ppid=,user=,pcpu=,rss=,comm=", "--sort=-pcpu"], { maxBuffer: 256 * 1024 });
        const lines = psOut.trim().split("\n").slice(0, 50);
        for (const line of lines) {
            if (!line.trim())
                continue;
            const parts = line.trim().split(/\s+/);
            if (parts.length < 6)
                continue;
            const pid = parseInt(parts[0], 10);
            if (Number.isNaN(pid))
                continue;
            processes.push({
                pid,
                ppid: parseInt(parts[1], 10) || 0,
                user: parts[2],
                cpu: parseFloat(parts[3]) || 0,
                mem: Math.round((parseInt(parts[4], 10) || 0) / 1024 * 10) / 10,
                name: parts.slice(5).join(" "),
                port: pidPortMap.get(pid) || "",
            });
        }
    }
    catch {
        // ps failure is non-fatal
    }
    return {
        processes,
        openPorts: [...allPortSet].sort((a, b) => a - b),
        externalPorts: [...externalPortSet].sort((a, b) => a - b),
    };
}
// sshd config changes rarely, and `sshd -T` forks a process, so don't read it
// every 5s tick. But a permanent cache would freeze a drift/fix for the daemon's
// whole lifetime (genie-stats doesn't restart when sshd reloads), defeating the
// point of reporting it — so cache with a coarse TTL instead.
const SSHD_CONFIG_TTL_MS = 5 * 60_000;
let cachedSshdConfig = null;
let cachedSshdConfigAt = 0;
/** Read effective sshd settings from `sshd -T` (authoritative — folds in the
 *  built-in defaults). One fork covers MaxStartups + ClientAlive*. Best-effort;
 *  needs root, which the stats daemon has. */
async function readSshdConfig() {
    if (cachedSshdConfig && Date.now() - cachedSshdConfigAt < SSHD_CONFIG_TTL_MS) {
        return cachedSshdConfig;
    }
    const empty = { maxStartups: null, clientAliveInterval: null, clientAliveCountMax: null };
    for (const bin of ["/usr/sbin/sshd", "sshd"]) {
        try {
            const { stdout } = await execFileAsync(bin, ["-T"], { maxBuffer: 256 * 1024 });
            const valueOf = (key) => {
                const line = stdout.split("\n").find((l) => l.toLowerCase().startsWith(`${key} `));
                return line ? (line.trim().split(/\s+/)[1] ?? null) : null;
            };
            const numOf = (key) => {
                const v = valueOf(key);
                if (v == null)
                    return null;
                const n = Number(v);
                return Number.isFinite(n) ? n : null;
            };
            cachedSshdConfig = {
                maxStartups: valueOf("maxstartups"),
                clientAliveInterval: numOf("clientaliveinterval"),
                clientAliveCountMax: numOf("clientalivecountmax"),
            };
            cachedSshdConfigAt = Date.now();
            return cachedSshdConfig;
        }
        catch {
            // try next candidate
        }
    }
    // Couldn't read sshd at all — cache the empty result under the same TTL so we
    // don't fork a doomed `sshd -T` every tick on a VM where it isn't available.
    cachedSshdConfig = empty;
    cachedSshdConfigAt = Date.now();
    return cachedSshdConfig;
}
/** Count "past MaxStartups" connection-drop log lines in the journal window
 *  `(sinceSec, untilSec]`. Bounded to the interval so the scan stays cheap.
 *  Returns 0 on the first tick (no baseline) or if journalctl is unavailable.
 *
 *  Deliberately NOT scoped to `-u ssh`/`-u sshd`: depending on the distro sshd
 *  runs as `ssh.service`, `sshd.service`, or socket-activated per-connection
 *  `ssh@.service` units, so a unit filter silently under-counts (a false zero).
 *  `past MaxStartups` is an unmistakable sshd string, so a journal-wide grep is
 *  both safe (no false positives) and robust across all those modes. The daemon
 *  runs as root, so it can read the whole journal. */
async function readMaxStartupsDrops(sinceSec, untilSec) {
    if (sinceSec == null)
        return 0;
    try {
        const { stdout } = await execFileAsync("journalctl", ["--since", `@${sinceSec}`, "--until", `@${untilSec}`, "-g", "past MaxStartups", "-o", "cat", "--no-pager"], { maxBuffer: 256 * 1024 });
        return stdout.split("\n").filter((l) => l.includes("MaxStartups")).length;
    }
    catch {
        return 0;
    }
}
/** Count interactive SSH login sessions via `who` (one line per pty login).
 *  Counts only login shells — the manager's non-pty exec/tunnel SSH channels
 *  don't create utmp entries, so this reflects open terminals, not every
 *  established :22 socket. */
async function readSshSessions() {
    try {
        const { stdout } = await execFileAsync("who", [], { maxBuffer: 64 * 1024 });
        return stdout.split("\n").filter((l) => l.trim()).length;
    }
    catch {
        return 0;
    }
}
/** Count established TCP connections terminating on the VM's sshd (local port
 *  22). Counts the real transport count — every manager exec/tunnel channel, not
 *  just pty logins — so orphaned connections that `who` can't see still show up.
 *  No `sport = :22` ss filter (its argv syntax varies across iproute2 versions);
 *  parse `ss -Htn` and match the local-address column ending in :22 instead. */
async function readSshEstablished() {
    try {
        const { stdout } = await execFileAsync("ss", ["-Htn", "state", "established"], { maxBuffer: 512 * 1024 });
        let count = 0;
        for (const line of stdout.split("\n")) {
            if (!line.trim())
                continue;
            const cols = line.trim().split(/\s+/);
            // `ss -Htn state established` omits the State column: Recv-Q Send-Q Local Peer.
            // Local address is cols[2]; match its trailing :port so [::]:22 / IPv6 work too.
            if (/:22$/.test(cols[2] ?? ""))
                count++;
        }
        return count;
    }
    catch {
        return 0;
    }
}
export async function collectStats(opts = {}) {
    let prev = opts.prevCpu ?? null;
    if (!prev && opts.warmCpu !== false) {
        const first = readCpuSample();
        if (first) {
            await new Promise((r) => setTimeout(r, 1000));
            prev = first;
        }
    }
    const cpuEnd = readCpuSample();
    const cpuPercent = cpuEnd ? cpuPercentFromSamples(prev, cpuEnd) : 0;
    const cpuSample = cpuEnd ?? { total: 0, idle: 0 };
    const { memUsedBytes, memTotalBytes, memPercent } = readMemory();
    const { diskUsedBytes, diskTotalBytes, diskPercent } = await readDisk();
    const { processes, openPorts, externalPorts } = await readProcessesAndPorts();
    const sshSessions = await readSshSessions();
    // Bound the drops window to [prev, now] so the next tick starts exactly here.
    const dropCheckSec = Math.floor(Date.now() / 1000);
    const [sshEstablished, sshdConfig, sshMaxStartupsDrops] = await Promise.all([
        readSshEstablished(),
        readSshdConfig(),
        readMaxStartupsDrops(opts.prevDropCheckSec ?? null, dropCheckSec),
    ]);
    return {
        stats: {
            cpuPercent,
            memUsedBytes,
            memTotalBytes,
            memPercent,
            diskUsedBytes,
            diskTotalBytes,
            diskPercent,
            processes,
            openPorts,
            externalPorts,
            sshSessions,
            sshEstablished,
            sshMaxStartups: sshdConfig.maxStartups,
            sshMaxStartupsDrops,
            sshClientAliveInterval: sshdConfig.clientAliveInterval,
            sshClientAliveCountMax: sshdConfig.clientAliveCountMax,
        },
        cpuSample,
        dropCheckSec,
    };
}
//# sourceMappingURL=collect.js.map