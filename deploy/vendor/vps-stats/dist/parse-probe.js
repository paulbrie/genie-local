/** Parse the combined shell probe output used by SSH fallback collection. */
export function parseProbeOutput(output) {
    let cpuPercent = 0;
    let memUsedBytes = 0;
    let memTotalBytes = 0;
    let diskUsedBytes = 0;
    let diskTotalBytes = 0;
    const cpuLines = output.split("===CPU2===");
    const parseCpu = (s) => {
        const m = s.match(/^cpu\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m);
        if (!m)
            return null;
        const vals = m.slice(1).map(Number);
        const total = vals.reduce((a, b) => a + b, 0);
        const idle = vals[3] + vals[4];
        return { total, idle };
    };
    const s1 = parseCpu(cpuLines[0]);
    const s2 = cpuLines[1] ? parseCpu(cpuLines[1]) : null;
    if (s1 && s2) {
        const dTotal = s2.total - s1.total;
        const dIdle = s2.idle - s1.idle;
        cpuPercent = dTotal > 0 ? Math.round(((dTotal - dIdle) / dTotal) * 100) : 0;
    }
    const memTotal = output.match(/MemTotal:\s+(\d+)\s+kB/);
    const memAvailable = output.match(/MemAvailable:\s+(\d+)\s+kB/);
    if (memTotal) {
        memTotalBytes = parseInt(memTotal[1], 10) * 1024;
        const availBytes = memAvailable ? parseInt(memAvailable[1], 10) * 1024 : 0;
        memUsedBytes = memTotalBytes - availBytes;
    }
    const diskLine = output.split("===DISK===")[1]?.trim();
    if (diskLine) {
        const parts = diskLine.split(/\s+/);
        if (parts.length >= 4) {
            diskTotalBytes = parseInt(parts[1], 10) || 0;
            diskUsedBytes = parseInt(parts[2], 10) || 0;
        }
    }
    const memPercent = memTotalBytes > 0 ? Math.round((memUsedBytes / memTotalBytes) * 100) : 0;
    const diskPercent = diskTotalBytes > 0 ? Math.round((diskUsedBytes / diskTotalBytes) * 100) : 0;
    const pidPortMap = new Map();
    const externalPortSet = new Set();
    const allPortSet = new Set();
    const portsSection = output.split("===PORTS===")[1];
    if (portsSection) {
        for (const line of portsSection.trim().split("\n")) {
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
    const processes = [];
    const procsSection = output.split("===PROCS===")[1]?.split("===PORTS===")[0];
    if (procsSection) {
        for (const line of procsSection.trim().split("\n")) {
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
    return {
        cpuPercent,
        memUsedBytes,
        memTotalBytes,
        memPercent,
        diskUsedBytes,
        diskTotalBytes,
        diskPercent,
        processes,
        openPorts: [...allPortSet].sort((a, b) => a - b),
        externalPorts: [...externalPortSet].sort((a, b) => a - b),
        sshSessions: 0, // not captured by the one-shot probe
    };
}
//# sourceMappingURL=parse-probe.js.map