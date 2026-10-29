/**
 * The Firewall page's core (firewall-core.ts), mirroring genie's
 * firewall-handler.ts: entry validation (genie's cases, the /16 limit, shell
 * injection attempts), the allowlist / status line / kernel-log parsing, and
 * the add / remove / on / off command sequences against a fake runner.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  ADD_SCRIPT, ALLOW_FILE, CMD, FIREWALL_SCRIPT, MIN_RANGE_PREFIX, NOT_INSTALLED, REMOVE_SCRIPT, addCommand, addEntry,
  firewallStatus, parseAllowlist, parseBlocks, parseShow, parseStateLine, removeCommand, removeEntry, setEnabled,
  systemdTime, validEntry, type FirewallDeps, type RunResult,
} from "./firewall-core";

describe("validEntry", () => {
  it("takes domains, IPv4 addresses and ranges no wider than /16", () => {
    for (const ok of ["example.com", "api.example.com", "a-b.example.co.uk", "1.2.3.4", "140.82.112.0/20", "10.0.0.0/16", "1.2.3.4/32"]) {
      assert.equal(validEntry(ok), true, ok);
    }
    assert.equal(MIN_RANGE_PREFIX, 16);
  });

  it("refuses wide ranges, bad octets and prefixes, and what isn't a host", () => {
    for (const bad of [
      "0.0.0.0/0", "1.0.0.0/8", "10.0.0.0/15", "1.2.3.4/33", "1.2.3.4/", "256.1.1.1", "1.2.3", "1.2.3.4.5",
      "localhost", "example", "-example.com", "example-.com", "http://example.com", "example.com/path", "*.example.com",
      "", " ", "a".repeat(250) + ".com", "::1", "2001:db8::1",
    ]) {
      assert.equal(validEntry(bad), false, bad);
    }
  });

  it("refuses shell and awk injection attempts", () => {
    for (const bad of [
      "example.com; rm -rf /", "example.com && curl evil.sh", "$(id).example.com", "`id`.example.com", "example.com'",
      "example.com\"", "example.com\nevil.com", "example.com #x", "example.com|sh", "' || true #", "-e evil.com",
      "example.com\\", "example.com > /etc/passwd", "1.2.3.4/16;id", "a.com\u0000b.com",
    ]) {
      assert.equal(validEntry(bad), false, JSON.stringify(bad));
    }
  });
});

describe("parseAllowlist", () => {
  const text = `# Outbound allowlist
# Anthropic
api.anthropic.com
claude.ai   # OAuth

  registry.npmjs.org
140.82.112.0/20  # added via Genie 2026-10-01
203.0.113.7  # genie manager (auto-added)
   # indented comment
`;
  it("skips comments and blanks, keeps trailing comments, marks the protected ones", () => {
    assert.deepEqual(parseAllowlist(text), [
      { entry: "api.anthropic.com", comment: undefined, protected: true },
      { entry: "claude.ai", comment: "OAuth", protected: false },
      { entry: "registry.npmjs.org", comment: undefined, protected: false },
      { entry: "140.82.112.0/20", comment: "added via Genie 2026-10-01", protected: false },
      { entry: "203.0.113.7", comment: "genie manager (auto-added)", protected: true },
    ]);
  });
  it("is empty for an empty file", () => assert.deepEqual(parseAllowlist(""), []));
});

describe("parseStateLine", () => {
  it("reads both wordings", () => {
    assert.deepEqual(parseStateLine("genie egress firewall: ON (57 allowed IPs and ranges)\nChain GENIE_EGRESS …"), {
      line: "genie egress firewall: ON (57 allowed IPs and ranges)",
      enforced: true,
      allowedIps: 57,
    });
    assert.deepEqual(parseStateLine("genie egress firewall: ON (42 allowed IPs)\n"), {
      line: "genie egress firewall: ON (42 allowed IPs)",
      enforced: true,
      allowedIps: 42,
    });
  });
  it("reads OFF, and nothing as off", () => {
    assert.deepEqual(parseStateLine("genie egress firewall: OFF\n"), { line: "genie egress firewall: OFF", enforced: false, allowedIps: 0 });
    assert.deepEqual(parseStateLine(""), { line: "", enforced: false, allowedIps: 0 });
  });
});

describe("parseBlocks", () => {
  const log = [
    "2026-10-29T13:27:23+00:00 paul-taz kernel: genie-egress-block: IN= OUT=ens3 SRC=10.128.5.198 DST=140.82.121.4 LEN=60 TOS=0x00 PREC=0x00 TTL=64 ID=13971 DF PROTO=TCP SPT=42078 DPT=443 WINDOW=64860 RES=0x00 SYN URGP=0 ",
    "2026-10-29T13:28:00+00:00 paul-taz kernel: genie-egress-block: IN= OUT=ens3 SRC=10.128.5.198 DST=1.1.1.1 LEN=84 PROTO=ICMP TYPE=8 CODE=0 ID=1 SEQ=1",
    "2026-10-29T13:29:27+00:00 paul-taz kernel: genie-egress-block: IN= OUT=ens3 SRC=10.128.5.198 DST=140.82.121.4 LEN=60 PROTO=TCP SPT=48800 DPT=443 SYN",
    "2026-10-29T13:29:30+00:00 paul-taz kernel: genie-egress-block: IN= OUT=ens3 SRC=10.128.5.198 DST=140.82.121.4 LEN=60 PROTO=TCP SPT=48801 DPT=22 SYN",
    "2026-10-29T13:30:00+00:00 paul-taz kernel: some other line DST=9.9.9.9 PROTO=TCP DPT=1",
    "garbage",
  ].join("\n");

  it("groups by address and port, most recent first", () => {
    assert.deepEqual(parseBlocks(log), [
      { ip: "140.82.121.4", port: 22, proto: "TCP", count: 1, lastSeen: "2026-10-29T13:29:30+00:00" },
      { ip: "140.82.121.4", port: 443, proto: "TCP", count: 2, lastSeen: "2026-10-29T13:29:27+00:00" },
      { ip: "1.1.1.1", port: undefined, proto: "ICMP", count: 1, lastSeen: "2026-10-29T13:28:00+00:00" },
    ]);
  });
  it("caps the list", () => assert.equal(parseBlocks(log, 1).length, 1));
});

describe("systemd values", () => {
  it("parses show output and timestamps", () => {
    assert.deepEqual(parseShow("LastTriggerUSec=Thu 2026-10-29 13:26:33 UTC\nActiveState=active\nUnitFileState=enabled\n"), {
      LastTriggerUSec: "Thu 2026-10-29 13:26:33 UTC",
      ActiveState: "active",
      UnitFileState: "enabled",
    });
    assert.equal(systemdTime("Thu 2026-10-29 13:26:33 UTC"), "2026-10-29T13:26:33.000Z");
    assert.equal(systemdTime("@1793280393"), "2026-10-29T13:26:33.000Z");
    assert.equal(systemdTime("n/a"), null);
    assert.equal(systemdTime(""), null);
  });
});

// ── The command sequences ───────────────────────────────────────────────────

type Call = { file: string; args: string[] };

/** A fake box: answers by command, records every call. */
function fakeBox(opts: { sudo?: boolean; installed?: boolean; enforced?: boolean; allow?: string; addResult?: string; removeResult?: string; applyCode?: number } = {}) {
  const o = { sudo: true, installed: true, enforced: true, allow: "api.anthropic.com\nclaude.ai\n", addResult: "ok", removeResult: "ok", applyCode: 0, ...opts };
  const calls: Call[] = [];
  const r = (code: number, stdout = "", stderr = ""): RunResult => ({ code, stdout, stderr });
  const deps: FirewallDeps = {
    now: () => new Date("2026-10-29T12:00:00Z"),
    reverse: async (ip) => (ip === "140.82.121.4" ? ["lb-140-82-121-4-fra.github.com"] : []),
    run: async (file, args) => {
      calls.push({ file, args });
      const cmd = [file, ...args].join(" ");
      if (cmd === "sudo -n true") return r(o.sudo ? 0 : 1, "", "sudo: a password is required");
      if (cmd === `test -x ${FIREWALL_SCRIPT}`) return r(o.installed ? 0 : 1);
      if (cmd === `sudo -n ${FIREWALL_SCRIPT} status`) {
        return r(0, o.enforced ? "genie egress firewall: ON (12 allowed IPs and ranges)\nChain …\n" : "genie egress firewall: OFF\n");
      }
      if (cmd === `cat ${ALLOW_FILE}`) return r(0, o.allow);
      if (file === "bash" && args[0] === "-c" && args[1] === ADD_SCRIPT) return r(0, `RESULT=${o.addResult}\n`);
      if (file === "bash" && args[0] === "-c" && args[1] === REMOVE_SCRIPT) return r(0, `RESULT=${o.removeResult}\n`);
      if (cmd === `sudo -n ${FIREWALL_SCRIPT}`) return r(o.applyCode, "", o.applyCode ? "ipset: boom" : "");
      if (file === "sudo" && args.includes("journalctl")) {
        return r(0, "2026-10-29T13:27:23+00:00 h kernel: genie-egress-block: IN= OUT=ens3 SRC=10.0.0.1 DST=140.82.121.4 LEN=60 PROTO=TCP SPT=1 DPT=443\n");
      }
      if (file === "systemctl" && args[1] === "genie-firewall.timer") return r(0, "LastTriggerUSec=Thu 2026-10-29 13:26:33 UTC\nActiveState=active\nUnitFileState=enabled\n");
      if (file === "systemctl" && args[1] === "genie-firewall.service") return r(0, "Result=success\n");
      return r(0);
    },
  };
  /** The calls that change something (not the reads every status makes). */
  const changes = () =>
    calls
      .map((c) => [c.file, ...c.args])
      .filter((a) => a[0] === "bash" || (a[0] === "sudo" && !["true", "journalctl"].includes(a[2]) && a[3] !== "status"));
  return { deps, calls, changes };
}

describe("firewallStatus", () => {
  it("puts it all together, with reverse DNS and the timer", async () => {
    const box = fakeBox();
    const s = await firewallStatus(box.deps);
    assert.equal(s.installed, true);
    assert.equal(s.sudo, true);
    assert.equal(s.enforced, true);
    assert.equal(s.allowedIps, 12);
    assert.deepEqual(s.allowlist.map((a) => [a.entry, a.protected]), [["api.anthropic.com", true], ["claude.ai", false]]);
    assert.deepEqual(s.blocks, [{ ip: "140.82.121.4", port: 443, proto: "TCP", count: 1, lastSeen: "2026-10-29T13:27:23+00:00", ptr: "lb-140-82-121-4-fra.github.com" }]);
    assert.deepEqual(s.timer, { active: "active", enabled: "enabled", lastTrigger: "2026-10-29T13:26:33.000Z", lastResult: "success" });
    assert.deepEqual(box.changes(), [], "a status changes nothing");
  });

  it("without the script: not installed, enforcement unknown, status never asked", async () => {
    const box = fakeBox({ installed: false });
    const s = await firewallStatus(box.deps);
    assert.equal(s.installed, false);
    assert.equal(s.enforced, null);
    assert.ok(!box.calls.some((c) => c.args.includes("status")));
  });

  it("without sudo: read-only, journal read without sudo", async () => {
    const box = fakeBox({ sudo: false });
    const s = await firewallStatus(box.deps);
    assert.equal(s.sudo, false);
    assert.equal(s.enforced, null);
    assert.ok(box.calls.some((c) => c.file === "journalctl"));
    assert.ok(!box.calls.some((c) => c.file === "sudo" && c.args[1] !== "true"));
  });
});

describe("addEntry", () => {
  it("passes the entry as argv to the fixed script, then re-applies while enforced", async () => {
    const box = fakeBox();
    const res = await addEntry(box.deps, "  Example.COM ");
    assert.equal(res.ok, true);
    assert.deepEqual(box.changes(), [
      ["bash", "-c", ADD_SCRIPT, "genie-fw-add", "example.com", "example.com  # added via admin 2026-10-29"],
      ["sudo", "-n", FIREWALL_SCRIPT],
    ]);
    assert.deepEqual(addCommand("x.com", "l"), ["bash", ["-c", ADD_SCRIPT, "genie-fw-add", "x.com", "l"]]);
  });

  it("doesn't re-apply (which would turn it back on) while off", async () => {
    const box = fakeBox({ enforced: false });
    assert.equal((await addEntry(box.deps, "example.com")).ok, true);
    assert.deepEqual(box.changes().map((a) => a[0]), ["bash"]);
  });

  it("refuses invalid entries before running anything", async () => {
    const box = fakeBox();
    for (const bad of ["example.com; reboot", "$(reboot)", "1.0.0.0/8", "' ; reboot #"]) {
      const res = await addEntry(box.deps, bad);
      assert.equal(res.ok, false);
    }
    assert.equal(box.calls.length, 0);
  });

  it("reports duplicates, a missing file, and refuses without sudo or the script", async () => {
    assert.match(((await addEntry(fakeBox({ addResult: "duplicate" }).deps, "claude.ai")) as { error: string }).error, /already allowed/);
    assert.match(((await addEntry(fakeBox({ addResult: "missing" }).deps, "a.com")) as { error: string }).error, /no \/etc\/genie/);
    const noSudo = fakeBox({ sudo: false });
    assert.match(((await addEntry(noSudo.deps, "a.com")) as { error: string }).error, /sudo -n was refused/);
    assert.deepEqual(noSudo.changes(), []);
    const missing = fakeBox({ installed: false });
    assert.equal(((await addEntry(missing.deps, "a.com")) as { error: string }).error, NOT_INSTALLED);
    assert.deepEqual(missing.changes(), []);
  });

  it("warns when the re-apply fails", async () => {
    const res = await addEntry(fakeBox({ applyCode: 1 }).deps, "a.com");
    assert.equal(res.ok, true);
    assert.match((res as { warning?: string }).warning ?? "", /re-applying failed: ipset: boom/);
  });
});

describe("removeEntry", () => {
  it("passes the entry as argv, then re-applies while enforced", async () => {
    const box = fakeBox();
    assert.equal((await removeEntry(box.deps, "claude.ai")).ok, true);
    assert.deepEqual(box.changes(), [["bash", "-c", REMOVE_SCRIPT, "genie-fw-remove", "claude.ai"], ["sudo", "-n", FIREWALL_SCRIPT]]);
    assert.deepEqual(removeCommand("x.com"), ["bash", ["-c", REMOVE_SCRIPT, "genie-fw-remove", "x.com"]]);
  });

  it("never removes api.anthropic.com, nor what the script calls protected", async () => {
    const box = fakeBox();
    const res = await removeEntry(box.deps, "API.anthropic.com");
    assert.equal(res.ok, false);
    assert.equal(box.calls.length, 0);
    const auto = fakeBox({ removeResult: "protected" });
    assert.match(((await removeEntry(auto.deps, "203.0.113.7")) as { error: string }).error, /auto-added/);
    assert.deepEqual(auto.changes().map((a) => a[0]), ["bash"], "no re-apply after a refusal");
  });

  it("doesn't re-apply while off; reports an entry that isn't there", async () => {
    const off = fakeBox({ enforced: false });
    await removeEntry(off.deps, "claude.ai");
    assert.deepEqual(off.changes().map((a) => a[0]), ["bash"]);
    assert.match(((await removeEntry(fakeBox({ removeResult: "notfound" }).deps, "x.com")) as { error: string }).error, /not in the allowlist/);
  });
});

describe("setEnabled", () => {
  it("on: apply, then the timer and the boot-time service", async () => {
    const box = fakeBox({ enforced: false });
    assert.equal((await setEnabled(box.deps, true)).ok, true);
    assert.deepEqual(box.changes(), [
      ["sudo", "-n", FIREWALL_SCRIPT],
      ["sudo", "-n", "systemctl", "enable", "--now", "genie-firewall.timer"],
      ["sudo", "-n", "systemctl", "enable", "genie-firewall.service"],
    ]);
  });

  it("off: genie-firewall off, then both units disabled", async () => {
    const box = fakeBox();
    assert.equal((await setEnabled(box.deps, false)).ok, true);
    assert.deepEqual(box.changes(), [
      ["sudo", "-n", FIREWALL_SCRIPT, "off"],
      ["sudo", "-n", "systemctl", "disable", "--now", "genie-firewall.timer", "genie-firewall.service"],
    ]);
    assert.deepEqual(CMD.off, ["sudo", ["-n", FIREWALL_SCRIPT, "off"]]);
  });

  it("doesn't install: without the script it explains, and runs nothing", async () => {
    const box = fakeBox({ installed: false });
    const res = await setEnabled(box.deps, true);
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /installed from genie/);
    assert.deepEqual(box.changes(), []);
  });

  it("on: a failed apply is reported and the timer is left alone", async () => {
    const box = fakeBox({ enforced: false, applyCode: 1 });
    const res = await setEnabled(box.deps, true);
    assert.equal(res.ok, false);
    assert.deepEqual(box.changes(), [["sudo", "-n", FIREWALL_SCRIPT]]);
  });
});

// The two allowlist scripts for real, on a temp copy (ALLOW_FILE swapped in the
// script text, `sudo -n tee` swapped for `tee`): hostile entries stay data.
describe("the allowlist scripts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fw-test-"));
  const file = path.join(dir, "allow.txt");
  const local = (script: string) => script.replace(`f=${ALLOW_FILE}`, `f='${file}'`).replaceAll("sudo -n tee", "tee");
  const run = (script: string, ...args: string[]) =>
    execFileSync("bash", ["-c", local(script), "t", ...args], { encoding: "utf8" }).trim();

  it("adds, refuses duplicates, appends after a file without a final newline", () => {
    writeFileSync(file, "api.anthropic.com\nclaude.ai  # x");
    assert.equal(run(ADD_SCRIPT, "example.com", "example.com  # added"), "RESULT=ok");
    assert.equal(readFileSync(file, "utf8"), "api.anthropic.com\nclaude.ai  # x\nexample.com  # added\n");
    assert.equal(run(ADD_SCRIPT, "claude.ai", "claude.ai"), "RESULT=duplicate");
    // A partial match isn't a duplicate (grep -x).
    assert.equal(run(ADD_SCRIPT, "ai", "ai"), "RESULT=ok");
  });

  it("removes exactly the entry, refuses auto-added, and leaves hostile values inert", () => {
    writeFileSync(file, "api.anthropic.com\nclaude.ai  # x\n203.0.113.7  # genie manager (auto-added)\n1.2.3.4\n");
    assert.equal(run(REMOVE_SCRIPT, "203.0.113.7"), "RESULT=protected");
    assert.equal(run(REMOVE_SCRIPT, "1.2.3"), "RESULT=notfound");
    assert.equal(run(REMOVE_SCRIPT, "claude.ai"), "RESULT=ok");
    assert.equal(readFileSync(file, "utf8"), "api.anthropic.com\n203.0.113.7  # genie manager (auto-added)\n1.2.3.4\n");
    const canary = path.join(dir, "pwned");
    for (const evil of [`$(touch ${canary})`, `'; touch ${canary}; '`, `\`touch ${canary}\``, `x" ; system("touch ${canary}") ; "`]) {
      assert.equal(run(REMOVE_SCRIPT, evil), "RESULT=notfound");
      assert.equal(run(ADD_SCRIPT, evil, evil), "RESULT=ok");
    }
    assert.throws(() => readFileSync(canary));
  });
});
