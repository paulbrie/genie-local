// Pure, dependency-free (tested): what the desktop's Cron widget makes of a crontab (widgets.ts reads them): its jobs,
// when each runs next and ran last (in the server's local time, as cron itself reads its schedules), a schedule said in
// words, and where a job's output goes.

/** A job as written: its schedule (five fields, or an @ word), its command, the comment just above it, the line it is on. */
export type CronJob = {
  source: string;
  line: number;
  schedule: string;
  command: string;
  /** /etc/crontab and /etc/cron.d's: the user it runs as */
  user: string | null;
  /** the comment lines right above it, joined (none: null) */
  note: string | null;
};

const SPECIAL: Record<string, string | null> = {
  "@reboot": null,
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/**
 * The jobs of a crontab: one a line, after its variables (NAME=value) and comments. `system`: /etc/crontab's and
 * /etc/cron.d's, a user's name between the schedule and the command. A comment block right above a job (no blank line
 * between) is its note.
 */
export function parseCrontab(text: string, source: string, system = false): CronJob[] {
  const out: CronJob[] = [];
  let note: string[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return void (note = []);
    if (line.startsWith("#")) return void note.push(line.replace(/^#+\s?/, ""));
    // (a variable: NAME=value, before any schedule)
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) return void (note = []);
    const words = line.split(/\s+/);
    const n = words[0].startsWith("@") ? 1 : 5;
    if (words.length < n + (system ? 2 : 1)) return void (note = []);
    const schedule = words.slice(0, n).join(" ");
    if (n === 1 && !(schedule in SPECIAL)) return void (note = []);
    if (n === 5 && !fieldsOf(schedule)) return void (note = []);
    // (the command: the rest of the line as written, its spacing kept)
    const rest = line.replace(new RegExp(`^(\\S+\\s+){${n + (system ? 1 : 0)}}`), "");
    out.push({ source, line: i + 1, schedule, command: rest, user: system ? words[n] : null, note: note.length ? note.join(" ") : null });
    note = [];
  });
  return out;
}

/** The values a schedule allows, field by field; `domStar` / `dowStar`: the field begins with `*` (cron's either-day rule). */
export type CronFields = { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function field(s: string, lo: number, hi: number, names?: string[], base = 0): Set<number> | null {
  const out = new Set<number>();
  const num = (x: string) => {
    const k = names?.indexOf(x.toLowerCase()) ?? -1;
    if (k >= 0) return k + base;
    return /^\d+$/.test(x) ? Number(x) : NaN;
  };
  for (const part of s.split(",")) {
    const m = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    let a: number, b: number;
    if (m[1] === "*") [a, b] = [lo, hi];
    else if (m[1].includes("-")) [a, b] = m[1].split("-").map(num) as [number, number];
    else {
      a = num(m[1]);
      // (a single value with a step runs from it to the end: "5/15" is 5, 20, 35, 50)
      b = m[2] ? hi : a;
    }
    if (!Number.isInteger(a) || !Number.isInteger(b) || step < 1 || a < lo || b > hi || a > b) return null;
    for (let x = a; x <= b; x += step) out.add(x);
  }
  return out;
}

/** A five-field schedule's values (an @ word as what it stands for; @reboot and anything unreadable: null). */
export function fieldsOf(schedule: string): CronFields | null {
  const expr = schedule.startsWith("@") ? SPECIAL[schedule] : schedule;
  if (!expr) return null;
  const f = expr.split(/\s+/);
  if (f.length !== 5) return null;
  const minute = field(f[0], 0, 59), hour = field(f[1], 0, 23), dom = field(f[2], 1, 31), month = field(f[3], 1, 12, MONTHS, 1);
  // (Sunday is 0 or 7)
  const dow7 = field(f[4], 0, 7, DAYS);
  if (!minute || !hour || !dom || !month || !dow7) return null;
  const dow = new Set([...dow7].map((d) => d % 7));
  return { minute, hour, dom, month, dow, domStar: f[2].startsWith("*"), dowStar: f[4].startsWith("*") };
}

/** Whether cron runs on this day: both day fields restricted, either will do; one of them `*`, the other decides. */
function dayMatches(f: CronFields, d: Date): boolean {
  if (!f.month.has(d.getMonth() + 1)) return false;
  const dom = f.dom.has(d.getDate()), dow = f.dow.has(d.getDay());
  return f.domStar || f.dowStar ? dom && dow : dom || dow;
}

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
/** (how far to look: a schedule for 29 February runs within eight years; one for 31 April never) */
const SEARCH_DAYS = 366 * 8 + 2;

/** The first minute after `from` the schedule runs at (local time), or null if it never does. */
export function nextRun(f: CronFields, from: Date): Date | null {
  const hours = sorted(f.hour), minutes = sorted(f.minute);
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let i = 0; i < SEARCH_DAYS; i++, day.setDate(day.getDate() + 1)) {
    if (!dayMatches(f, day)) continue;
    for (const h of hours)
      for (const m of minutes) {
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
        if (t > from) return t;
      }
  }
  return null;
}

/** The last minute at or before `from` the schedule ran at (local time), or null if never. */
export function prevRun(f: CronFields, from: Date): Date | null {
  const hours = sorted(f.hour).reverse(), minutes = sorted(f.minute).reverse();
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let i = 0; i < SEARCH_DAYS; i++, day.setDate(day.getDate() - 1)) {
    if (!dayMatches(f, day)) continue;
    for (const h of hours)
      for (const m of minutes) {
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
        if (t <= from) return t;
      }
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Runs of consecutive values, "4–6, 14–16" (`fmt` each value). */
function ranges(values: number[], fmt: (n: number) => string): string {
  const out: string[] = [];
  for (let i = 0; i < values.length; ) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j++;
    out.push(j - i >= 2 ? `${fmt(values[i])}–${fmt(values[j])}` : values.slice(i, j + 1).map(fmt).join(", "));
    i = j + 1;
  }
  return out.join(", ");
}

/**
 * Values spaced evenly all through the field's range, from its start ("*\/5") or a little after ("5-55/10", from :05):
 * that step and where they start; else null.
 */
function everyStep(values: number[], lo: number, hi: number): { step: number; from: number } | null {
  if (values.length < 2) return null;
  const step = values[1] - values[0], from = values[0];
  if (from - lo >= step || values.some((v, i) => v !== from + i * step) || values[values.length - 1] + step <= hi) return null;
  return { step, from };
}

/**
 * A schedule in words, short: "every 5 min, 04:00–06:55", "daily at 07:00 and 17:00", "hourly at :15", "Mondays at
 * 03:00". What it can't put better stays as written.
 */
export function describeSchedule(schedule: string): string {
  if (schedule === "@reboot") return "at boot";
  const f = fieldsOf(schedule);
  if (!f) return schedule;
  const mins = sorted(f.minute), hours = sorted(f.hour);
  const allHours = hours.length === 24, allMins = mins.length === 60;
  let time: string;
  const ms = everyStep(mins, 0, 59), hs = everyStep(hours, 0, 23);
  const mStep = ms ? `${ms.step} min${ms.from ? ` from :${pad(ms.from)}` : ""}` : null;
  const hStep = hs && !hs.from ? hs.step : null;
  if (allMins && allHours) time = "every minute";
  else if (allMins) time = `every minute, ${ranges(hours, (h) => `${pad(h)}:00`)} hours`;
  else if (mStep && allHours) time = `every ${mStep}`;
  else if (mStep) {
    // (the hours as spans of clock time: 4–6 is 04:00 to 06:55)
    const last = mins[mins.length - 1];
    const spans: string[] = [];
    for (let i = 0; i < hours.length; ) {
      let j = i;
      while (j + 1 < hours.length && hours[j + 1] === hours[j] + 1) j++;
      spans.push(`${pad(hours[i])}:00–${pad(hours[j])}:${pad(last)}`);
      i = j + 1;
    }
    time = `every ${mStep}, ${spans.join(", ")}`;
  } else if (allHours) time = `hourly at ${mins.map((m) => `:${pad(m)}`).join(", ")}`;
  else if (hStep && mins.length === 1) time = `every ${hStep} h at :${pad(mins[0])}`;
  else if (hours.length * mins.length <= 4) {
    const times = hours.flatMap((h) => mins.map((m) => `${pad(h)}:${pad(m)}`));
    time = `at ${times.length > 1 ? `${times.slice(0, -1).join(", ")} and ${times[times.length - 1]}` : times[0]}`;
  } else return schedule;
  const days: string[] = [];
  const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (!f.dowStar) days.push(ranges(sorted(f.dow), (d) => dowNames[d]));
  if (!f.domStar) days.push(`day ${ranges(sorted(f.dom), String)}`);
  const monthNames = MONTHS.map((m) => m[0].toUpperCase() + m.slice(1));
  const inMonths = f.month.size < 12 ? ` in ${ranges(sorted(f.month), (m) => monthNames[m - 1])}` : "";
  if (!days.length) return `${time.startsWith("at ") ? "daily " : ""}${time}${inMonths}`;
  return `${time}, ${days.join(" or ")}${inMonths}`;
}

/**
 * What a command tells of itself: the folder it `cd`s to first, the file its output is appended or written to (`>>` /
 * `>`, `~` and `$HOME` as `home`; not /dev/null), and a short name: the script it runs (its file name), else its first
 * word's.
 */
export function commandInfo(command: string, home: string): { dir: string | null; log: string | null; name: string } {
  const expand = (p: string) => p.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home).replace(/^["']|["']$/g, "");
  const cd = /^\s*cd\s+(\S+)\s*(?:&&|;)/.exec(command);
  // (stdout's redirect: `>> file`, `> file`, `1>> file`; not `2>`, not `>&`)
  const out = /(?:^|[^0-9&>])1?>>?\s*([^\s&|;>]+)/.exec(command);
  const target = out ? expand(out[1]) : null;
  const log = target && target !== "/dev/null" ? target : null;
  // (the name: the last script it names, the one a runner like node or tsx is given; else the last command of a chain's
  // first word, `test -e x || /sbin/job` being job's; redirects and their files left out)
  const bare = command.replace(/^\s*cd\s+\S+\s*(?:&&|;)\s*/, "").replace(/\d?>>?\s*&?\s*\S+/g, " ");
  const script = bare.split(/\s+/).filter((w) => /\.(m?[jt]s|sh|py|rb|pl)$/.test(w) && !w.startsWith("-")).pop();
  // (a group's braces and parentheses aren't commands: `test -x a || { cd / && run-parts /etc/cron.daily; }`)
  const segs = bare.replace(/[{}()]/g, " ").split(/&&|\|\||;/).map((s) => s.trim()).filter(Boolean);
  const words = (segs[segs.length - 1] ?? "").split(/\s+/).filter(Boolean);
  const first = words.find((w) => w !== "env" && !w.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !/^(sudo|nice|ionice|timeout|flock)$/.test(w));
  const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
  // (run-parts runs a folder's scripts: the folder is the job, cron.daily)
  const name = !script && first && base(first) === "run-parts" && words.length > 1 ? words[words.length - 1] : (script ?? first ?? command.trim());
  return { dir: cd ? expand(cd[1]) : null, log, name: base(name) };
}

/** What a log's last line says: an error, by its words; else nothing to flag. */
export function looksLikeError(line: string): boolean {
  return /\b(error|failed|failure|exception|traceback|fatal|denied)\b|\bERR!/i.test(line);
}
