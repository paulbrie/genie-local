"use client";

import { CalendarClock } from "lucide-react";

import { ago, Empty, ROW, Subhead, useOpenPath, usePolled, WidgetHeader, WidgetList } from "@/components/desktop/widget-parts";
import { StatusDot } from "@/components/ui/status-dot";
import type { CronRow } from "@/lib/widgets";
import { cn } from "@/lib/utils";

// The desktop's Cron widget: the jobs in the crontab of the user the admin runs as, then the system's, the soonest
// first, each with its schedule in words, when it runs next and, where its output goes to a file, whether that file
// kept up and its last line. From /api/widgets/cron every 30 s; a row opens its log's folder (else the folder it runs
// in) in Files.

type Cron = { running: boolean | null; me: string; jobs: CronRow[] };

/** "in 3 min", from an ISO time (short, as `ago`). */
function until(at: string): string {
  const s = Math.round((new Date(at).getTime() - Date.now()) / 1000);
  if (s < 60) return "in <1 min";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86_400) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86_400)} d`;
}

/** (a job still running when its log is looked at hasn't written yet: this long after it started, it's late) */
const GRACE_MS = 10 * 60_000;

type Health = { color: string; label: string; pulse?: boolean };
/** A job's state, from its log: failing (its last line reads as an error), late (not written since its last run), fine, or unknown. */
function healthOf(j: CronRow): Health {
  if (!j.log) return { color: "bg-muted-foreground/30", label: "Its output isn't kept in a file" };
  if (!j.log.at) return { color: "bg-muted-foreground/30", label: "No log yet" };
  if (j.log.error) return { color: "bg-red-500", label: "Its log's last line reads as an error", pulse: true };
  const prev = j.prev ? new Date(j.prev).getTime() : null;
  if (prev && Date.now() - prev > GRACE_MS && new Date(j.log.at).getTime() < prev - 60_000)
    return { color: "bg-amber-500", label: `Its log hasn't been written since its last run (${ago(j.prev!)})` };
  return { color: "bg-emerald-500", label: "Its log is up to date" };
}

/** A job's project, when it runs in one's folder. */
const projectOf = (j: CronRow) => /^\/opt\/project\/projects\/([^/]+)/.exec(j.dir ?? "")?.[1] ?? null;

function JobRow({ j }: { j: CronRow }) {
  const open = useOpenPath();
  const h = healthOf(j), project = projectOf(j);
  const folder = j.log ? j.log.path.replace(/\/[^/]*$/, "") || "/" : j.dir;
  const title = [
    j.note,
    `${j.when} (${j.schedule})${j.scope === "system" ? `, as ${j.user}` : ""}`,
    j.next ? `next ${new Date(j.next).toLocaleString()}` : j.schedule === "@reboot" ? "runs at boot" : "never runs",
    j.command,
    j.log ? `log ${j.log.path}${j.log.at ? `, written ${ago(j.log.at)}` : ", not there yet"}` : null,
    j.log?.last ? `last line: ${j.log.last}` : null,
    `${j.source}, line ${j.line}`,
    h.label,
  ]
    .filter(Boolean)
    .join("\n");
  const body = (
    <>
      <StatusDot color={h.color} pulse={h.pulse} size="sm" label={h.label} />
      {project && <span className="shrink-0 opacity-70">{project}</span>}
      <span className="min-w-0 shrink-0 truncate text-foreground/90">{j.name}</span>
      <span className="min-w-0 truncate text-[10px] opacity-60">{j.when}</span>
      <span className="ml-auto shrink-0 text-[10px] opacity-70">{j.next ? until(j.next) : j.schedule === "@reboot" ? "at boot" : "never"}</span>
    </>
  );
  return (
    <div title={title}>
      {folder ? (
        <button type="button" onClick={() => open(`/files?dir=${encodeURIComponent(folder)}`)} className={ROW}>
          {body}
        </button>
      ) : (
        <div className={cn(ROW, "hover:bg-transparent hover:text-muted-foreground")}>{body}</div>
      )}
      {j.log?.last && <p className={cn("truncate pr-2 pl-7 font-mono text-[10px]", j.log.error ? "text-red-500/90" : "text-muted-foreground/60")}>{j.log.last}</p>}
    </div>
  );
}

/** Cron: the crontab's jobs and the system's, the soonest first; what's failing or late flagged in its header. */
export function CronWidget({ folded }: { folded: boolean }) {
  const { data, failed } = usePolled<Cron>("/api/widgets/cron", 30_000);
  const soonest = (a: CronRow, b: CronRow) => (a.next ? new Date(a.next).getTime() : Infinity) - (b.next ? new Date(b.next).getTime() : Infinity) || a.name.localeCompare(b.name);
  const mine = (data?.jobs ?? []).filter((j) => j.scope === "user").sort(soonest);
  const system = (data?.jobs ?? []).filter((j) => j.scope === "system").sort(soonest);
  const failing = mine.filter((j) => j.log?.error).length;
  const late = mine.filter((j) => healthOf(j).color === "bg-amber-500").length;
  const next = mine.find((j) => j.next);
  const note = !data
    ? failed
      ? "couldn't read"
      : ""
    : data.running === false
      ? "cron is stopped"
      : failing
        ? `${failing} failing`
        : late
          ? `${late} late`
          : next
            ? `next: ${next.name} ${until(next.next!)}`
            : mine.length
              ? "nothing scheduled"
              : "no jobs";
  return (
    <>
      <WidgetHeader id="cron" icon={CalendarClock} title="Cron" count={data ? mine.length : null} note={note} folded={folded} />
      {!folded && (
        <WidgetList>
          {!data && <Empty>{failed ? "Couldn't read the crontabs." : "Loading…"}</Empty>}
          {data && (
            <>
              {data.running === false && <Empty>The cron service isn&apos;t running: none of these will run.</Empty>}
              <Subhead>{data.me}&apos;s crontab</Subhead>
              {!mine.length && <Empty>No jobs.</Empty>}
              {mine.map((j) => (
                <JobRow key={j.key} j={j} />
              ))}
              <Subhead>System</Subhead>
              {!system.length && <Empty>No jobs.</Empty>}
              {system.map((j) => (
                <JobRow key={j.key} j={j} />
              ))}
            </>
          )}
        </WidgetList>
      )}
    </>
  );
}
