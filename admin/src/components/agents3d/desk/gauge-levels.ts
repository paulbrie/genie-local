/**
 * The whiteboard's server dials (CPU, MEM, DISK): what each shows and its
 * colour, from /api/stats. Pure, so the thresholds are tested.
 */

/** What /api/stats returns (see SystemStats in lib/stats; memUsedBytes there is MemTotal − MemAvailable). */
export type StatsReading = {
  cpuPercent: number;
  memPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskPercent: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
};

export type Level = "ok" | "warn" | "bad" | "none";
export const LEVEL_COLORS: Record<Level, string> = { ok: "#22c55e", warn: "#f59e0b", bad: "#ef4444", none: "#64748b" };

/** CPU: amber over 70 %, red over 90 %. */
export const CPU_WARN = 70;
export const CPU_BAD = 90;
/** MEM, by what's available (MemAvailable, not "free"): amber under 4 GB, red under 2.5 GB (the team's memory rule). */
export const MEM_WARN_GB = 4;
export const MEM_BAD_GB = 2.5;
/** DISK: amber over 80 % used, red over 90 %. */
export const DISK_WARN = 80;
export const DISK_BAD = 90;

/** GB as `free -g` and the team count them (GiB). */
const GB = 1024 ** 3;

export type Dial = {
  label: "CPU" | "MEM" | "DISK";
  /** Needle position, 0–100 (null: no data). */
  pct: number | null;
  value: string;
  sub: string;
  level: Level;
  /** Where the scale turns amber and red, 0–100 (MEM's come from its total). */
  zones: [number, number];
};

const pct = (n: number) => Math.max(0, Math.min(100, n));
const gb = (bytes: number) => (bytes / GB >= 10 ? `${Math.round(bytes / GB)}` : (bytes / GB).toFixed(1));

/** The three dials for a reading (null: no data, shown greyed with a dash). */
export function dialsFor(s: StatsReading | null): Dial[] {
  if (!s) return (["CPU", "MEM", "DISK"] as const).map((label) => ({ label, pct: null, value: "—", sub: "", level: "none", zones: [100, 100] }));
  const memFree = Math.max(0, s.memTotalBytes - s.memUsedBytes);
  const diskFree = Math.max(0, s.diskTotalBytes - s.diskUsedBytes);
  return [
    {
      label: "CPU",
      pct: pct(s.cpuPercent),
      value: `${Math.round(s.cpuPercent)}%`,
      sub: "",
      level: s.cpuPercent > CPU_BAD ? "bad" : s.cpuPercent > CPU_WARN ? "warn" : "ok",
      zones: [CPU_WARN, CPU_BAD],
    },
    {
      label: "MEM",
      pct: pct(s.memPercent),
      value: `${Math.round(s.memPercent)}%`,
      sub: `${gb(memFree)} GB free`,
      level: memFree < MEM_BAD_GB * GB ? "bad" : memFree < MEM_WARN_GB * GB ? "warn" : "ok",
      zones: [pct(100 - (100 * MEM_WARN_GB * GB) / s.memTotalBytes), pct(100 - (100 * MEM_BAD_GB * GB) / s.memTotalBytes)],
    },
    {
      label: "DISK",
      pct: pct(s.diskPercent),
      value: `${Math.round(s.diskPercent)}%`,
      sub: `${gb(diskFree)} GB free`,
      level: s.diskPercent > DISK_BAD ? "bad" : s.diskPercent > DISK_WARN ? "warn" : "ok",
      zones: [DISK_WARN, DISK_BAD],
    },
  ];
}

/** A dial's look as a string: its texture is repainted only when this changes. */
export const dialKey = (d: Dial) => `${d.pct === null ? "-" : Math.round(d.pct)}|${d.value}|${d.sub}|${d.level}`;
