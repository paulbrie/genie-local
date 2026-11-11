// Pure, dependency-free (tested): what the desktop's Health and Git widgets make of what systemd, docker and git say
// (widgets.ts does the asking).

/** ok: up · warn: on its way (starting, reloading) · down: failed, unhealthy, crashed · off: stopped on purpose. */
export type HealthState = "ok" | "warn" | "down" | "off";
export type HealthItem = { kind: "service" | "container"; name: string; state: HealthState; detail: string };

const RANK: Record<HealthState, number> = { down: 0, warn: 1, ok: 2, off: 3 };

/**
 * The curated services and every container, each with its state, the ones that need you first. A service that's
 * inactive is off (admin-dev is, most of the time); one that failed is down. A container that exited cleanly, or was
 * never started, is off; one that exited with an error, restarts or is unhealthy is down.
 */
export function healthOf(
  services: readonly { unit: string; active: string; sub: string; curated: boolean }[],
  containers: readonly { name: string; state: string; status: string }[],
): HealthItem[] {
  const out: HealthItem[] = [];
  for (const s of services) {
    if (!s.curated) continue;
    const state: HealthState =
      s.active === "active" ? "ok" : s.active === "failed" ? "down" : s.active === "activating" || s.active === "reloading" ? "warn" : "off";
    out.push({ kind: "service", name: s.unit.replace(/\.service$/, ""), state, detail: `${s.active} (${s.sub})` });
  }
  for (const c of containers) {
    const status = c.status.toLowerCase();
    const exit = /exited \((\d+)\)/.exec(status);
    const state: HealthState =
      c.state === "running"
        ? status.includes("(unhealthy)")
          ? "down"
          : status.includes("health: starting")
            ? "warn"
            : "ok"
        : c.state === "restarting" || c.state === "dead" || (exit && exit[1] !== "0")
          ? "down"
          : "off";
    out.push({ kind: "container", name: c.name, state, detail: c.status });
  }
  return out.sort((a, b) => RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name));
}

/** A repo's state, from `git status --porcelain=v2 --branch`. */
export type RepoState = { branch: string | null; upstream: boolean; ahead: number; behind: number; changed: number; untracked: number };

export function parseGitStatus(stdout: string): RepoState {
  const st: RepoState = { branch: null, upstream: false, ahead: 0, behind: 0, changed: 0, untracked: 0 };
  for (const line of stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice(14).trim();
      st.branch = head === "(detached)" ? null : head;
    } else if (line.startsWith("# branch.upstream ")) st.upstream = true;
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) [st.ahead, st.behind] = [Number(m[1]), Number(m[2])];
    } else if (/^[12u] /.test(line)) st.changed++;
    else if (line.startsWith("? ")) st.untracked++;
  }
  return st;
}
