import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { commandInfo, describeSchedule, fieldsOf, looksLikeError, nextRun, parseCrontab, prevRun } from "./cron-core";

// (local times, as cron reads its schedules: the tests hold whatever the machine's zone)
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const f = (s: string) => {
  const x = fieldsOf(s);
  assert.ok(x, `${s} should parse`);
  return x;
};

describe("parseCrontab", () => {
  it("reads jobs with the comment above them, skipping variables, blanks and what isn't a schedule", () => {
    const jobs = parseCrontab(
      [
        "SHELL=/bin/bash",
        "* * * * * /usr/bin/node /opt/x/stats.mjs >/dev/null 2>&1",
        "# trafficsim ticket #261: TomTom traffic",
        "# every 5 min",
        "*/5 4-6,14-16 * * * cd /opt/p && node  collect.ts >> ~/t.log 2>&1",
        "",
        "# orphan comment",
        "",
        "@daily /usr/bin/backup",
        "@sometimes nope",
        "61 * * * * out of range",
        "not a job at all",
      ].join("\n"),
      "crontab",
    );
    assert.deepEqual(
      jobs.map((j) => [j.line, j.schedule, j.command, j.note]),
      [
        [2, "* * * * *", "/usr/bin/node /opt/x/stats.mjs >/dev/null 2>&1", null],
        [5, "*/5 4-6,14-16 * * *", "cd /opt/p && node  collect.ts >> ~/t.log 2>&1", "trafficsim ticket #261: TomTom traffic every 5 min"],
        [9, "@daily", "/usr/bin/backup", null],
      ],
    );
  });

  it("takes the user from a system crontab's line", () => {
    const [j] = parseCrontab("30 3 * * 0 root test -e /run/systemd/system || /sbin/e2scrub_all", "/etc/cron.d/e2scrub_all", true);
    assert.equal(j.user, "root");
    assert.equal(j.command, "test -e /run/systemd/system || /sbin/e2scrub_all");
  });
});

describe("fieldsOf", () => {
  it("reads lists, ranges, steps, names and Sunday as 7", () => {
    const x = f("5/20 4-6,14 1,15 jan-mar mon-fri");
    assert.deepEqual([...x.minute], [5, 25, 45]);
    assert.deepEqual([...x.hour], [4, 5, 6, 14]);
    assert.deepEqual([...x.month], [1, 2, 3]);
    assert.deepEqual([...x.dow], [1, 2, 3, 4, 5]);
    assert.deepEqual([...f("0 0 * * 7").dow], [0]);
  });
  it("refuses what cron would", () => {
    for (const s of ["60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "5-1 * * * *", "*/0 * * * *", "* * * *", "@reboot"]) assert.equal(fieldsOf(s), null, s);
  });
});

describe("nextRun / prevRun", () => {
  it("finds the next minute inside the hours allowed, and the last one before", () => {
    const x = f("*/5 4-6,14-16 * * *");
    assert.deepEqual(nextRun(x, at(2026, 11, 16, 6, 55)), at(2026, 11, 16, 14, 0));
    assert.deepEqual(nextRun(x, at(2026, 11, 16, 14, 2)), at(2026, 11, 16, 14, 5));
    assert.deepEqual(nextRun(x, at(2026, 11, 16, 17, 0)), at(2026, 11, 17, 4, 0));
    assert.deepEqual(prevRun(x, at(2026, 11, 16, 12, 0)), at(2026, 11, 16, 6, 55));
    assert.deepEqual(prevRun(x, at(2026, 11, 16, 14, 5)), at(2026, 11, 16, 14, 5));
  });
  it("runs on either day when both day fields are given, and on the other's when one is *", () => {
    // (the 13th, or any Friday)
    const either = f("0 9 13 * 5");
    assert.deepEqual(nextRun(either, at(2026, 11, 16)), at(2026, 11, 20, 9, 0));
    // (Fridays only: the day of the month is *)
    assert.deepEqual(nextRun(f("0 9 * * 5"), at(2026, 11, 13, 10)), at(2026, 11, 20, 9, 0));
  });
  it("finds 29 February some years off, and says never for 31 April", () => {
    assert.deepEqual(nextRun(f("0 0 29 2 *"), at(2026, 3, 1)), at(2028, 2, 29));
    assert.equal(nextRun(f("0 0 31 4 *"), at(2026, 1, 1)), null);
  });
});

describe("describeSchedule", () => {
  it("says the common ones in words", () => {
    assert.equal(describeSchedule("* * * * *"), "every minute");
    assert.equal(describeSchedule("*/5 * * * *"), "every 5 min");
    assert.equal(describeSchedule("*/5 4-6,14-16 * * *"), "every 5 min, 04:00–06:55, 14:00–16:55");
    assert.equal(describeSchedule("0 7,17 * * *"), "daily at 07:00 and 17:00");
    assert.equal(describeSchedule("15 * * * *"), "hourly at :15");
    assert.equal(describeSchedule("0 */6 * * *"), "every 6 h at :00");
    assert.equal(describeSchedule("30 3 * * 0"), "at 03:30, Sun");
    assert.equal(describeSchedule("0 9 * * 1-5"), "at 09:00, Mon–Fri");
    assert.equal(describeSchedule("@monthly"), "at 00:00, day 1");
    assert.equal(describeSchedule("@reboot"), "at boot");
    assert.equal(describeSchedule("5-55/10 * * * *"), "every 10 min from :05");
    assert.equal(describeSchedule("2-59/15 9-17 * * 1-5"), "every 15 min from :02, 09:00–17:47, Mon–Fri");
  });
  it("leaves as written what it can't put better", () => {
    assert.equal(describeSchedule("3,17,41 1,5,9,13 * * *"), "3,17,41 1,5,9,13 * * *");
  });
});

describe("commandInfo", () => {
  it("finds the folder, the log and the script", () => {
    assert.deepEqual(
      commandInfo("cd /opt/project/projects/trafficsim && env -u DATABASE_URL /usr/bin/node node_modules/tsx/dist/cli.mjs scripts/traffic-collect.ts b87c >> /home/genie/.local/state/t.log 2>&1", "/home/genie"),
      { dir: "/opt/project/projects/trafficsim", log: "/home/genie/.local/state/t.log", name: "traffic-collect.ts" },
    );
  });
  it("expands ~ and $HOME, and ignores /dev/null and stderr's own redirects", () => {
    assert.equal(commandInfo("backup.sh > ~/b.log", "/home/u").log, "/home/u/b.log");
    assert.equal(commandInfo("backup.sh >>$HOME/b.log 2>&1", "/home/u").log, "/home/u/b.log");
    assert.equal(commandInfo("/usr/bin/node /opt/x/stats.mjs >/dev/null 2>&1", "/h").log, null);
    assert.equal(commandInfo("job 2>/tmp/err.log", "/h").log, null);
    assert.equal(commandInfo("/usr/bin/node /opt/x/stats.mjs >/dev/null 2>&1", "/h").name, "stats.mjs");
    assert.equal(commandInfo("test -e /run/systemd/system || /sbin/e2scrub_all", "/h").name, "e2scrub_all");
    assert.equal(commandInfo("command -v debian-sa1 > /dev/null && debian-sa1 1 1", "/h").name, "debian-sa1");
    assert.equal(commandInfo("test -x /usr/sbin/anacron || { cd / && run-parts --report /etc/cron.daily; }", "/h").name, "cron.daily");
    assert.equal(commandInfo("cd / && run-parts --report /etc/cron.hourly", "/h").name, "cron.hourly");
  });
});

describe("looksLikeError", () => {
  it("flags a last line that reads as a failure", () => {
    assert.ok(looksLikeError("TypeError: fetch failed"));
    assert.ok(looksLikeError("npm ERR! code 1"));
    assert.ok(!looksLikeError("saved 412 segments for plan b87c01a7"));
  });
});
