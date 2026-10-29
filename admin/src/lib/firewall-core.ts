// The Firewall page's logic, mirroring genie's egress-firewall handler
// (projects/genie/packages/manager/src/handlers/firewall-handler.ts) for THIS
// server: entry validation, parsing what the script / allowlist / kernel log
// say, and the add / remove / on / off sequences. Pure — every command goes
// through an injected runner (`src/lib/firewall.ts` binds execFile), so
// firewall.test.ts drives it against a fake one. The client imports the types
// and validEntry from here too, so nothing here may import from node.
//
// Commands run as genie with `sudo -n`, always as argv (execFile, no shell).
// The two that edit the allowlist are fixed bash scripts that take the entry as
// a positional argument ("$1"), so an entry never becomes shell text.

/** Installed by genie (Standard Setup or its firewall toggle); its source is GENIE_FIREWALL_SETUP_SCRIPT. */
export const FIREWALL_SCRIPT = "/usr/local/sbin/genie-firewall";
/** root:root 644; one entry per line, `# comments`. */
export const ALLOW_FILE = "/etc/genie/firewall-allow.txt";
export const FIREWALL_TIMER = "genie-firewall.timer";
export const FIREWALL_SERVICE = "genie-firewall.service";
/** Never removable: Claude sessions on the box stop working without it. */
export const REQUIRED_ENTRY = "api.anthropic.com";

export type AllowEntry = {
  entry: string;
  comment?: string;
  /** Removal is refused: api.anthropic.com and genie's "auto-added" manager address. */
  protected: boolean;
};

export type Block = {
  ip: string;
  port?: number;
  proto?: string;
  count: number;
  lastSeen?: string;
  /** Best-effort reverse DNS. */
  ptr?: string;
};

export type FirewallStatus = {
  /** /usr/local/sbin/genie-firewall is installed. */
  installed: boolean;
  /** `sudo -n` works for genie; without it the page is read-only. */
  sudo: boolean;
  /** The OUTPUT jump for genie is in place; null when it couldn't be asked (no sudo, no script). */
  enforced: boolean | null;
  allowedIps: number;
  /** The status line as the script printed it. */
  stateLine: string;
  /** The allowlist file exists. */
  allowFile: boolean;
  allowlist: AllowEntry[];
  /** The last 24 h, most recent first. */
  blocks: Block[];
  /** The installed script knows IPv4 ranges (hash:net); older ones only resolve names and single addresses. */
  rangesSupported: boolean;
  timer: {
    active: string;
    enabled: string;
    /** ISO time of the timer's last trigger: when the allowlist was last re-applied. */
    lastTrigger: string | null;
    /** How that run ended (the service's Result: success, exit-code, …). */
    lastResult: string | null;
  };
  checkedAt: string;
};

export type FirewallResult =
  | { ok: true; status: FirewallStatus; warning?: string }
  | { ok: false; error: string; status?: FirewallStatus };

export type RunResult = { code: number; stdout: string; stderr: string };
/** Runs `file` with `args` (no shell); resolves with the exit code instead of throwing on a non-zero one. */
export type Runner = (file: string, args: string[]) => Promise<RunResult>;

export type FirewallDeps = {
  run: Runner;
  /** Reverse DNS for the blocks; resolves [] when there's no name. */
  reverse?: (ip: string) => Promise<string[]>;
  /** For the "added via admin <date>" stamp. */
  now?: () => Date;
};

// ── Entries ────────────────────────────────────────────────────────────────

// As genie's main (523e044): a bare domain, an IPv4 address, or an IPv4 range
// a.b.c.d/nn no wider than /16 (65,536 addresses) — wider ones would all but
// undo the allowlist; private ranges are already open.
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
export const MIN_RANGE_PREFIX = 16;

export function validEntry(entry: string): boolean {
  if (DOMAIN_RE.test(entry)) return true;
  const m = entry.match(IPV4_RE);
  if (!m || !m.slice(1, 5).every((o) => Number(o) <= 255)) return false;
  return m[5] === undefined || (Number(m[5]) >= MIN_RANGE_PREFIX && Number(m[5]) <= 32);
}

export const normalizeEntry = (raw: string) => raw.trim().toLowerCase();

export const ENTRY_HELP = `Enter a bare domain (example.com), an IPv4 address, or an IPv4 range no wider than /${MIN_RANGE_PREFIX} (140.82.112.0/20)`;

// ── Parsing ────────────────────────────────────────────────────────────────

export function parseAllowlist(text: string): AllowEntry[] {
  const entries: AllowEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const hash = line.indexOf("#");
    const entry = (hash >= 0 ? line.slice(0, hash) : line).trim();
    const comment = hash >= 0 ? line.slice(hash + 1).trim() : undefined;
    if (!entry) continue;
    entries.push({
      entry,
      comment: comment || undefined,
      protected: entry === REQUIRED_ENTRY || (comment?.includes("auto-added") ?? false),
    });
  }
  return entries;
}

/**
 * The first line of `genie-firewall status`: "genie egress firewall: ON (57
 * allowed IPs and ranges)", or "(57 allowed IPs)" from scripts before ranges,
 * or ": OFF".
 */
export function parseStateLine(output: string): { enforced: boolean; allowedIps: number; line: string } {
  const line = output.split("\n")[0]?.trim() ?? "";
  return {
    line,
    enforced: /:\s*ON\b/.test(line),
    allowedIps: Number(line.match(/\((\d+) allowed IPs(?: and ranges)?\)/)?.[1] ?? 0),
  };
}

export const BLOCK_TAG = "genie-egress-block:";

/**
 * Kernel-log lines (journalctl -k -o short-iso), e.g.
 *   2026-07-31T09:12:01+0000 host kernel: genie-egress-block: IN= OUT=eth0
 *     SRC=10.0.0.5 DST=1.2.3.4 ... PROTO=TCP SPT=51000 DPT=443 ...
 * grouped by address and port, most recent first, at most `limit`.
 */
export function parseBlocks(text: string, limit = 20): Block[] {
  const byKey = new Map<string, Block>();
  for (const line of text.split("\n")) {
    const m = line.match(/^(\S+)\s.*genie-egress-block:.*?DST=([0-9.]+).*?PROTO=(\S+)(?:.*?DPT=(\d+))?/);
    if (!m) continue;
    const [, ts, ip, proto, dpt] = m;
    const port = dpt ? Number(dpt) : undefined;
    const key = `${ip}:${port ?? "-"}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.count += 1;
      prev.lastSeen = ts;
    } else {
      byKey.set(key, { ip, port, proto, count: 1, lastSeen: ts });
    }
  }
  return [...byKey.values()].sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "")).slice(0, limit);
}

/** `systemctl show -p A -p B` → { A: "…", B: "…" }. */
export function parseShow(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return out;
}

/** A systemd timestamp ("Thu 2026-10-29 13:26:33 UTC", "@1793280393", "n/a", "") as ISO, or null. */
export function systemdTime(v: string | undefined): string | null {
  if (!v || v === "n/a" || v === "0") return null;
  const unix = v.match(/^@(\d+)$/);
  if (unix) return new Date(Number(unix[1]) * 1000).toISOString();
  const m = v.match(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?: (\S+))?/);
  if (!m) return null;
  const t = m[3] === undefined || m[3] === "UTC" ? Date.parse(`${m[1]}T${m[2]}Z`) : Date.parse(`${m[1]} ${m[2]} ${m[3]}`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ── Commands ───────────────────────────────────────────────────────────────

const sudo = (...args: string[]): [string, string[]] => ["sudo", ["-n", ...args]];

export const CMD = {
  sudoCheck: sudo("true"),
  installed: ["test", ["-x", FIREWALL_SCRIPT]] as [string, string[]],
  status: sudo(FIREWALL_SCRIPT, "status"),
  apply: sudo(FIREWALL_SCRIPT),
  off: sudo(FIREWALL_SCRIPT, "off"),
  readAllow: ["cat", [ALLOW_FILE]] as [string, string[]],
  ranges: ["grep", ["-qF", "hash:net", FIREWALL_SCRIPT]] as [string, string[]],
  journal: (withSudo: boolean): [string, string[]] => {
    const args = ["journalctl", "-k", "-o", "short-iso", "--no-pager", "--since", "24 hours ago"];
    return withSudo ? sudo(...args) : [args[0], args.slice(1)];
  },
  timerShow: ["systemctl", ["show", FIREWALL_TIMER, "-p", "LastTriggerUSec", "-p", "ActiveState", "-p", "UnitFileState"]] as [string, string[]],
  serviceShow: ["systemctl", ["show", FIREWALL_SERVICE, "-p", "Result"]] as [string, string[]],
  enableTimer: sudo("systemctl", "enable", "--now", FIREWALL_TIMER),
  // Applies at boot, as genie's setup leaves it.
  enableService: sudo("systemctl", "enable", FIREWALL_SERVICE),
  // Both, or the boot-time service would turn it back on after a reboot.
  disableUnits: sudo("systemctl", "disable", "--now", FIREWALL_TIMER, FIREWALL_SERVICE),
};

// Genie's add: awk the first column, grep -xF for the exact entry, then append
// with `sudo tee -a`. $1 is the entry, $2 the whole line to append; neither is
// ever part of the script text. A file that doesn't end in a newline gets one
// first, or the new entry would be glued onto the last line.
export const ADD_SCRIPT = `f=${ALLOW_FILE}
if [ ! -f "$f" ]; then echo "RESULT=missing"; exit 0; fi
if awk '{print $1}' "$f" | grep -qxF -- "$1"; then echo "RESULT=duplicate"; exit 0; fi
if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then printf '\\n' | sudo -n tee -a "$f" > /dev/null || exit 1; fi
printf '%s\\n' "$2" | sudo -n tee -a "$f" > /dev/null || exit 1
echo "RESULT=ok"`;

// Genie's remove: awk -v (the entry is an awk variable, compared with ==, never
// a pattern) finds the line, an auto-added one is refused, the rest is written
// back through `sudo tee`, which keeps the file root:root 644.
export const REMOVE_SCRIPT = `f=${ALLOW_FILE}
LINE=$(awk -v e="$1" '$1==e {print; exit}' "$f" 2>/dev/null)
if [ -z "$LINE" ]; then echo "RESULT=notfound"; exit 0; fi
if printf '%s\\n' "$LINE" | grep -q 'auto-added'; then echo "RESULT=protected"; exit 0; fi
tmp=$(mktemp) || exit 1
awk -v e="$1" '$1!=e' "$f" > "$tmp" && sudo -n tee "$f" < "$tmp" > /dev/null
rc=$?
rm -f "$tmp"
[ "$rc" = 0 ] || exit 1
echo "RESULT=ok"`;

export const addCommand = (entry: string, line: string): [string, string[]] => ["bash", ["-c", ADD_SCRIPT, "genie-fw-add", entry, line]];
export const removeCommand = (entry: string): [string, string[]] => ["bash", ["-c", REMOVE_SCRIPT, "genie-fw-remove", entry]];

const call = (deps: FirewallDeps, [file, args]: [string, string[]]) => deps.run(file, args);
const resultOf = (out: string) => out.match(/RESULT=(\w+)/)?.[1] ?? null;
const lastLine = (r: RunResult) => (r.stderr || r.stdout).trim().split("\n").pop()?.slice(0, 300) || `exit ${r.code}`;

const NO_SUDO = "sudo -n was refused for the genie user on this server, so the firewall can only be viewed here";
export const NOT_INSTALLED =
  "The egress firewall isn't installed on this server. It's installed from genie: run Genie Standard Setup on this server, or turn on Claude egress on its card in genie.";

// ── Status ─────────────────────────────────────────────────────────────────

async function resolvePtrs(blocks: Block[], reverse: FirewallDeps["reverse"]): Promise<void> {
  if (!reverse) return;
  const unique = [...new Set(blocks.map((b) => b.ip))].slice(0, 15);
  const ptrs = new Map<string, string>();
  await Promise.all(
    unique.map(async (ip) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const names = await Promise.race([
          reverse(ip),
          new Promise<string[]>((_, rej) => (timer = setTimeout(() => rej(new Error("timeout")), 1500))),
        ]);
        if (names[0]) ptrs.set(ip, names[0].replace(/\.$/, ""));
      } catch {
        /* no PTR — show the bare IP */
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  for (const b of blocks) {
    const ptr = ptrs.get(b.ip);
    if (ptr) b.ptr = ptr;
  }
}

export async function firewallStatus(deps: FirewallDeps): Promise<FirewallStatus> {
  const [sudoOk, installed, allow, timer, service, ranges] = await Promise.all([
    call(deps, CMD.sudoCheck).then((r) => r.code === 0),
    call(deps, CMD.installed).then((r) => r.code === 0),
    call(deps, CMD.readAllow),
    call(deps, CMD.timerShow),
    call(deps, CMD.serviceShow),
    call(deps, CMD.ranges).then((r) => r.code === 0),
  ]);
  // Root is needed to ask iptables; genie is in adm, so the journal reads either way.
  const [state, journal] = await Promise.all([
    installed && sudoOk ? call(deps, CMD.status) : null,
    call(deps, CMD.journal(sudoOk)),
  ]);
  const parsed = state && state.code === 0 ? parseStateLine(state.stdout) : null;
  const blockLines = journal.stdout.split("\n").filter((l) => l.includes(BLOCK_TAG)).slice(-80).join("\n");
  const blocks = parseBlocks(blockLines);
  await resolvePtrs(blocks, deps.reverse);
  const t = parseShow(timer.stdout);
  const s = parseShow(service.stdout);
  return {
    installed,
    sudo: sudoOk,
    enforced: parsed ? parsed.enforced : null,
    allowedIps: parsed?.allowedIps ?? 0,
    stateLine: parsed?.line ?? "",
    allowFile: allow.code === 0,
    allowlist: allow.code === 0 ? parseAllowlist(allow.stdout) : [],
    blocks,
    rangesSupported: ranges,
    timer: {
      active: t.ActiveState ?? "",
      enabled: t.UnitFileState ?? "",
      lastTrigger: systemdTime(t.LastTriggerUSec),
      lastResult: s.Result || null,
    },
    checkedAt: (deps.now?.() ?? new Date()).toISOString(),
  };
}

// ── Changes ────────────────────────────────────────────────────────────────

// One change at a time: two adds racing would both pass the duplicate check.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

/**
 * Re-apply only while enforcement is on: a bare `genie-firewall` re-installs the
 * OUTPUT jump, which would quietly turn back on a firewall someone turned off.
 * Returns a warning when the apply itself failed (the file is changed either way).
 */
async function reapplyIfEnforced(deps: FirewallDeps): Promise<string | undefined> {
  const state = await call(deps, CMD.status);
  if (state.code !== 0 || !parseStateLine(state.stdout).enforced) return undefined;
  const r = await call(deps, CMD.apply);
  return r.code === 0 ? undefined : `Saved, but re-applying failed: ${lastLine(r)}`;
}

async function precheck(deps: FirewallDeps): Promise<string | null> {
  if ((await call(deps, CMD.sudoCheck)).code !== 0) return NO_SUDO;
  if ((await call(deps, CMD.installed)).code !== 0) return NOT_INSTALLED;
  return null;
}

export function addEntry(deps: FirewallDeps, raw: string): Promise<FirewallResult> {
  return serialized(async () => {
    const value = normalizeEntry(raw);
    if (!validEntry(value)) return { ok: false, error: ENTRY_HELP };
    const refused = await precheck(deps);
    if (refused) return { ok: false, error: refused };
    const stamp = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
    const r = await call(deps, addCommand(value, `${value}  # added via admin ${stamp}`));
    const result = resultOf(r.stdout);
    if (result === "missing") return { ok: false, error: `There's no ${ALLOW_FILE} on this server yet; genie's firewall setup creates it` };
    if (result === "duplicate") return { ok: false, error: `${value} is already allowed` };
    if (result !== "ok") return { ok: false, error: `Couldn't write the allowlist: ${lastLine(r)}` };
    const warning = await reapplyIfEnforced(deps);
    return { ok: true, status: await firewallStatus(deps), warning };
  });
}

export function removeEntry(deps: FirewallDeps, raw: string): Promise<FirewallResult> {
  return serialized(async () => {
    const value = normalizeEntry(raw);
    if (!validEntry(value)) return { ok: false, error: "Invalid entry" };
    if (value === REQUIRED_ENTRY) return { ok: false, error: `${REQUIRED_ENTRY} is required for Claude sessions and can't be removed` };
    const refused = await precheck(deps);
    if (refused) return { ok: false, error: refused };
    const r = await call(deps, removeCommand(value));
    const result = resultOf(r.stdout);
    if (result === "notfound") return { ok: false, error: `${value} is not in the allowlist` };
    if (result === "protected") return { ok: false, error: "The genie manager's auto-added address can't be removed (REST MCP would break)" };
    if (result !== "ok") return { ok: false, error: `Couldn't write the allowlist: ${lastLine(r)}` };
    const warning = await reapplyIfEnforced(deps);
    return { ok: true, status: await firewallStatus(deps), warning };
  });
}

/** On: apply + the timer (and the boot-time service). Off: `genie-firewall off` + both units disabled. */
export function setEnabled(deps: FirewallDeps, enabled: boolean): Promise<FirewallResult> {
  return serialized(async () => {
    const refused = await precheck(deps);
    if (refused) return { ok: false, error: refused };
    if (enabled) {
      if ((await call(deps, CMD.readAllow)).code !== 0) {
        return { ok: false, error: `There's no ${ALLOW_FILE} on this server; genie's firewall setup creates it` };
      }
      const apply = await call(deps, CMD.apply);
      if (apply.code !== 0) return { ok: false, error: `genie-firewall failed: ${lastLine(apply)}`, status: await firewallStatus(deps) };
      const timer = await call(deps, CMD.enableTimer);
      const service = await call(deps, CMD.enableService);
      const failed = [timer, service].find((r) => r.code !== 0);
      return { ok: true, status: await firewallStatus(deps), warning: failed ? `On, but enabling the timer failed: ${lastLine(failed)}` : undefined };
    }
    const off = await call(deps, CMD.off);
    if (off.code !== 0) return { ok: false, error: `genie-firewall off failed: ${lastLine(off)}`, status: await firewallStatus(deps) };
    const units = await call(deps, CMD.disableUnits);
    return {
      ok: true,
      status: await firewallStatus(deps),
      // Left enabled, the timer would turn it back on within 10 minutes.
      warning: units.code === 0 ? undefined : `Off, but disabling the timer failed (it will turn back on): ${lastLine(units)}`,
    };
  });
}
