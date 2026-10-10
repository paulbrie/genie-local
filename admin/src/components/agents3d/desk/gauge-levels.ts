/**
 * The whiteboard's server dials (CPU, MEM, DISK) and the per-core bars under
 * the CPU dial: what each shows, its colour and where it sits, from /api/stats.
 * Pure, so the thresholds and the layout are tested.
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
  /** How many cores (os.cpus()). */
  cpuCores?: number;
  /** Busy % per core, cpu0… in /proc/stat order (null on the server's first reading). */
  cpuPerCore?: number[] | null;
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
/** The CPU thresholds, shared by the dial (the total) and the per-core bars. */
export const cpuLevel = (p: number): Level => (p > CPU_BAD ? "bad" : p > CPU_WARN ? "warn" : "ok");
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
      level: cpuLevel(s.cpuPercent),
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

/** A dial's look as a string: its state changes only when this does. */
export const dialKey = (d: Dial) => `${d.pct === null ? "-" : Math.round(d.pct)}|${d.value}|${d.sub}|${d.level}`;
/** What the dial's face shows, without the needle and the number: it's repainted only when this changes. */
export const faceKey = (d: Dial) => `${d.label}|${d.sub}|${d.level}|${d.zones.join(",")}|${d.pct === null ? "-" : ""}`;

/** Needles, numbers and bars ease to a new reading over this long (wall clock, ease-out). */
export const EASE_MS = 800;
/** A value easing from `from` to `to`, started at `t0` (performance.now() ms). */
export type Eased = { from: number; to: number; t0: number };
const easeOut = (x: number) => 1 - (1 - x) ** 3;

/** Where an eased value is at `now`. */
export function easedAt(e: Eased, now: number): number {
  const k = Math.min(1, Math.max(0, (now - e.t0) / EASE_MS));
  return e.from + (e.to - e.from) * easeOut(k);
}

/** Still moving at `now` (frames are asked for only while it is). */
export const easing = (e: Eased, now: number) => e.from !== e.to && now - e.t0 < EASE_MS;

/**
 * A new reading `to`: eased from wherever the value is now, so a reading that
 * arrives mid-ease just retargets. The first one starts from `start`; the same
 * target changes nothing; `snap` (reduced motion) jumps.
 */
export function retarget(e: Eased | null, to: number, now: number, start = 0, snap = false): Eased {
  if (snap) return { from: to, to, t0: now };
  if (!e) return { from: start, to, t0: now };
  if (e.to === to) return e;
  return { from: easedAt(e, now), to, t0: now };
}

/** One core's bar: its fill, 0–100 (null: no data, grey). */
export type CoreBar = { pct: number | null; level: Level };

/** Grey bars shown before the first reading says how many cores there are (this box has 16). */
export const DEFAULT_CORES = 16;

/**
 * A bar per core, coloured by the CPU dial's thresholds. Without per-core data
 * (no reading, or the server's first one) the bars are grey: as many as the
 * reading's core count, else as many as last shown.
 */
export function coreBarsFor(s: StatsReading | null, lastCount = DEFAULT_CORES): CoreBar[] {
  const per = s?.cpuPerCore;
  if (Array.isArray(per) && per.length > 0 && per.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return per.map((n) => ({ pct: pct(n), level: cpuLevel(n) }));
  }
  const n = s?.cpuCores && s.cpuCores > 0 ? s.cpuCores : lastCount;
  return Array.from({ length: n }, () => ({ pct: null, level: "none" }));
}

/** The bars' look as a string: the strip is repainted only when this changes (whole percents). */
export const coreBarsKey = (bars: CoreBar[]) => bars.map((b) => (b.pct === null ? "-" : `${Math.round(b.pct)}${b.level[0]}`)).join(",");

/** At most this many bars in a row; more cores wrap into further rows. */
export const CORES_PER_ROW = 16;

/** A bar's slot in the strip, as fractions of its width and height (y down). */
export type CoreCell = { x: number; y: number; w: number; h: number };

/**
 * Where each core's bar goes in the strip: rows of at most `perRow`, balanced
 * (20 cores: 2 rows of 10, not 16 + 4), filled left to right, top row first, so
 * core i keeps its column; a short last row is left-aligned. `gap` is the share
 * of a slot left empty around a bar, across and between rows.
 */
export function coreCells(n: number, perRow = CORES_PER_ROW, gap = 0.25): CoreCell[] {
  if (n <= 0) return [];
  const rows = Math.ceil(n / perRow);
  const cols = Math.ceil(n / rows);
  const cw = 1 / cols;
  const rh = 1 / rows;
  const rowGap = rows > 1 ? gap / 2 : 0;
  return Array.from({ length: n }, (_, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    return { x: col * cw + (cw * gap) / 2, y: row * rh + (rh * rowGap) / 2, w: cw * (1 - gap), h: rh * (1 - rowGap) };
  });
}
