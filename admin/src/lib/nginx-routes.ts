/**
 * The Nginx routes, as data (T242): every server block (its listen ports, names
 * and TLS) and every location in it (path → upstream), parsed from the config
 * files with their includes followed; what listens on each upstream port (from
 * `ss`); the problems at a glance (a port two apps share, a route to a port
 * nothing listens on, a project server nothing routes to, a port outside the
 * allowed range, a path twice in one server); the conflict checks before a port
 * change; the generated projects.conf rendered from the apps' ports, and a line
 * diff to preview it; applying it with a rollback when `nginx -t` fails.
 *
 * Pure (no fs, no DB, no child processes): the server side feeds it
 * (src/lib/nginx.ts), so all of it is unit-tested (nginx-routes.test.ts).
 */

// ---- parsing ---------------------------------------------------------------

/** One directive: `name args…;` or `name args… { block }`, with where it was written. */
export type Directive = {
  name: string;
  args: string[];
  block?: Directive[];
  file: string;
  line: number;
};

type Token = { t: string; kind: "word" | "{" | "}" | ";"; line: number };

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\n") {
      line++;
      i++;
    } else if (c === " " || c === "\t" || c === "\r") {
      i++;
    } else if (c === "#") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "{" || c === "}" || c === ";") {
      out.push({ t: c, kind: c, line });
      i++;
    } else if (c === '"' || c === "'") {
      // A quoted word: up to the matching quote, `\` escaping the next char.
      const q = c;
      const start = line;
      let s = "";
      i++;
      while (i < n && text[i] !== q) {
        if (text[i] === "\\" && i + 1 < n) {
          s += text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === "\n") line++;
        s += text[i++];
      }
      i++;
      out.push({ t: s, kind: "word", line: start });
    } else {
      let s = "";
      while (i < n && !/[\s{};#"']/.test(text[i])) s += text[i++];
      // (a `#` or quote inside a word, e.g. a regex: keep it in the word)
      if (i < n && (text[i] === "#" || text[i] === '"' || text[i] === "'") && s !== "") {
        while (i < n && !/[\s{};]/.test(text[i])) s += text[i++];
      }
      out.push({ t: s, kind: "word", line });
    }
  }
  return out;
}

/** Parse one config file's text into its directives (blocks nested). Lenient: an unclosed block ends at the file's end. */
export function parseNginx(text: string, file: string): Directive[] {
  const toks = tokenize(text);
  let k = 0;
  function list(): Directive[] {
    const out: Directive[] = [];
    let words: Token[] = [];
    while (k < toks.length) {
      const tok = toks[k++];
      if (tok.kind === "word") {
        words.push(tok);
      } else if (tok.kind === ";") {
        if (words.length) out.push({ name: words[0].t, args: words.slice(1).map((w) => w.t), file, line: words[0].line });
        words = [];
      } else if (tok.kind === "{") {
        const head = words[0];
        const block = list();
        if (head) out.push({ name: head.t, args: words.slice(1).map((w) => w.t), block, file, line: head.line });
        words = [];
      } else {
        return out; // "}"
      }
    }
    return out;
  }
  return list();
}

/** Reads the files an `include` pattern names (a glob in its last segment), relative ones against the config root. */
export type IncludeResolver = (pattern: string) => Promise<{ file: string; text: string }[]>;

/**
 * The directives with every `include` replaced by the included files' directives
 * (recursively, at most 8 deep), each keeping the file it came from.
 */
export async function expandIncludes(dirs: Directive[], resolve: IncludeResolver, depth = 0): Promise<Directive[]> {
  const out: Directive[] = [];
  for (const d of dirs) {
    if (d.name === "include" && !d.block && d.args[0] && depth < 8) {
      for (const f of await resolve(d.args[0])) {
        out.push(...(await expandIncludes(parseNginx(f.text, f.file), resolve, depth + 1)));
      }
    } else if (d.block) {
      out.push({ ...d, block: await expandIncludes(d.block, resolve, depth) });
    } else {
      out.push(d);
    }
  }
  return out;
}

// ---- the routes ------------------------------------------------------------

export type Listen = { addr: string | null; port: number; ssl: boolean; defaultServer: boolean };
export type ServerInfo = {
  id: string;
  file: string;
  line: number;
  listen: Listen[];
  /** server_name values; `_` (the catch-all) kept as is */
  names: string[];
  /** TLS here: a `listen … ssl` or an ssl_certificate */
  tls: boolean;
};

export type Upstream =
  | { kind: "proxy"; scheme: string; host: string; port: number; uri: string; raw: string }
  | { kind: "socket"; path: string; raw: string }
  | { kind: "redirect"; status: number; to: string }
  | { kind: "static"; root: string }
  | { kind: "internal" }
  | { kind: "other"; raw: string };

export type Route = {
  id: string;
  serverId: string;
  /** "", "=", "~", "~*", "^~", or "@" for a named location */
  modifier: string;
  path: string;
  upstream: Upstream;
  file: string;
  line: number;
  /** from the generated include (apps.port), not a hand-written file */
  generated: boolean;
};

const DEFAULT_PORT: Record<string, number> = { http: 80, https: 443 };

/** proxy_pass's target: host and port (or a unix socket), or `other` when it has variables. */
export function parseProxyPass(raw: string): Upstream {
  const sock = /^https?:\/\/unix:([^:]+):?(.*)$/.exec(raw);
  if (sock) return { kind: "socket", path: sock[1], raw };
  const m = /^(https?):\/\/(\[[^\]]+\]|[^/:$]+)(?::(\d+))?(\/.*)?$/.exec(raw);
  if (!m || raw.includes("$")) return { kind: "other", raw };
  return { kind: "proxy", scheme: m[1], host: m[2], port: m[3] ? Number(m[3]) : DEFAULT_PORT[m[1]], uri: m[4] ?? "", raw };
}

function parseListen(args: string[]): Listen | null {
  const a = args[0];
  if (!a || a.startsWith("unix:")) return null;
  // "3000", "[::]:3000", "127.0.0.1:8080", "*:80"
  const m = /^(?:(\[[^\]]+\]|[^:]+):)?(\d+)$/.exec(a);
  if (!m) return null;
  return { addr: m[1] ?? null, port: Number(m[2]), ssl: args.includes("ssl"), defaultServer: args.includes("default_server") };
}

function upstreamOf(block: Directive[]): Upstream {
  const find = (name: string) => block.find((d) => d.name === name);
  const pp = find("proxy_pass");
  if (pp?.args[0]) return parseProxyPass(pp.args[0]);
  const ret = find("return");
  if (ret) {
    const [code, to] = ret.args;
    return { kind: "redirect", status: Number(code) || 302, to: to ?? "" };
  }
  if (find("internal")) return { kind: "internal" };
  const root = find("alias") ?? find("root");
  if (root?.args[0]) return { kind: "static", root: root.args[0] };
  const other = block.find((d) => /_pass$/.test(d.name) || d.name === "try_files");
  return { kind: "other", raw: other ? `${other.name} ${other.args.join(" ")}` : "" };
}

/**
 * Every server block and its locations, from the (include-expanded) top-level
 * directives: the `http` block's servers, or servers at the top (a sites file
 * parsed alone). `isGenerated(file)` tells the generated include's locations.
 */
export function extractRoutes(top: Directive[], isGenerated: (file: string) => boolean): { servers: ServerInfo[]; routes: Route[] } {
  const servers: ServerInfo[] = [];
  const routes: Route[] = [];
  const http = top.find((d) => d.name === "http" && d.block);
  const serverDirs = (http?.block ?? top).filter((d) => d.name === "server" && d.block);
  serverDirs.forEach((s, si) => {
    const block = s.block ?? [];
    const listen = block.filter((d) => d.name === "listen").map((d) => parseListen(d.args)).filter((l): l is Listen => l !== null);
    const names = block.filter((d) => d.name === "server_name").flatMap((d) => d.args);
    const tls = listen.some((l) => l.ssl) || block.some((d) => d.name === "ssl_certificate");
    const id = `s${si}`;
    servers.push({ id, file: s.file, line: s.line, listen: listen.length ? listen : [{ addr: null, port: 80, ssl: false, defaultServer: false }], names, tls });
    const walk = (dirs: Directive[]) => {
      for (const d of dirs) {
        if (d.name !== "location" || !d.block) continue;
        const [a, b] = d.args;
        const modifier = b !== undefined ? a : a?.startsWith("@") ? "@" : "";
        const p = b !== undefined ? b : a ?? "";
        routes.push({ id: `${id}:${d.file}:${d.line}`, serverId: id, modifier, path: p, upstream: upstreamOf(d.block), file: d.file, line: d.line, generated: isGenerated(d.file) });
        walk(d.block); // nested locations
      }
    };
    walk(block);
  });
  return { servers, routes };
}

// ---- what listens ----------------------------------------------------------

export type Listener = { addr: string; port: number; pid: number | null; process: string | null };

/** `ss -ltnH -p` → one entry per listening port (the first holder; pids only for our own processes). */
export function parseSsListeners(stdout: string): Listener[] {
  const out: Listener[] = [];
  const seen = new Set<number>();
  for (const line of stdout.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const local = cols[3];
    if (!local) continue;
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (!Number.isInteger(port) || seen.has(port)) continue;
    seen.add(port);
    const pm = /pid=(\d+)/.exec(line);
    const nm = /users:\(\("([^"]*)"/.exec(line);
    out.push({ addr: local.slice(0, local.lastIndexOf(":")), port, pid: pm ? Number(pm[1]) : null, process: nm ? nm[1] : null });
  }
  return out.sort((a, b) => a.port - b.port);
}

// ---- the admin's apps, and the problems ------------------------------------

/** An admin app, as the routes see it: its port, its mount path, whether its server runs. */
export type AppRow = { appId: number; project: string; app: string; port: number | null; mount: string; running: boolean };
/**
 * A listener, told (for our own processes; others' are unreadable): its project (from its working directory), the
 * systemd unit it runs in (from its cgroup), and its command (argv[0..1]).
 */
export type ListenerInfo = Listener & { cwd: string | null; project: string | null; service?: string | null; command?: string | null };

/** The systemd unit a /proc/<pid>/cgroup names (`0::/system.slice/admin-dev.service` → "admin-dev"), or null. */
export function serviceOfCgroup(text: string): string | null {
  for (const line of text.split("\n")) {
    const m = /\/([^/]+)\.service$/.exec(line.slice(line.lastIndexOf(":") + 1).trim());
    if (m) return m[1];
  }
  return null;
}

/** The line under a listener's name: its systemd unit, else its command (short), else `ss`'s process name, never a thread's; and its pid. */
export function listenerDetail(l: ListenerInfo): string {
  const base = (p: string | undefined) => p?.split("/").filter(Boolean).pop();
  const [argv0, argv1] = l.command?.split(" ") ?? [];
  const what = l.service
    ? `${l.service}.service`
    : argv0
      ? [base(argv0), base(argv1)].filter(Boolean).join(" ")
      : l.process && l.process !== "MainThread" ? l.process : null;
  return [what ?? (l.pid ? null : "not ours"), l.pid ? `pid ${l.pid}` : null].filter(Boolean).join(" · ");
}

const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno", "python", "python3", "ruby", "perl", "java", "sh", "bash"]);

/**
 * What listens, named, never by a thread's name ("MainThread" is what `ss` shows for node): its project; else its
 * systemd unit (admin, admin-dev, code-server; set only for the unit's own server, see readListeners, so a project's
 * server or a tool started from the admin's terminals isn't called "admin"); else its command (the script, past an
 * interpreter); else its working directory's name; else the process name `ss` gave.
 */
export function listenerName(l: ListenerInfo): string {
  if (l.project) return l.project;
  if (l.service) return l.service;
  const base = (p: string | null | undefined) => p?.split("/").filter(Boolean).pop() ?? null;
  const [argv0, argv1] = l.command?.split(" ") ?? [];
  const cmd = INTERPRETERS.has(base(argv0) ?? "") ? base(argv1) : base(argv0);
  return cmd ?? base(l.cwd) ?? l.process ?? "a process";
}

export type Problem = {
  kind: "duplicate-port" | "dead-route" | "unrouted" | "port-range" | "duplicate-path";
  level: "error" | "warn" | "info";
  message: string;
  port?: number;
  routeIds?: string[];
  appIds?: number[];
};

/** The ports an app may take: inside the range, none of the box's own. */
export type PortPolicy = { min: number; max: number; reserved: number[] };
export const DEFAULT_PORT_POLICY: PortPolicy = { min: 3001, max: 9999, reserved: [3000, 3002, 3003, 5432, 6379, 8880] };

export function portAllowed(port: number, policy: PortPolicy = DEFAULT_PORT_POLICY): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return `${port} is not a port`;
  if (port < policy.min || port > policy.max) return `${port} is outside the apps' range (${policy.min}–${policy.max})`;
  if (policy.reserved.includes(port)) return `${port} is reserved (Nginx, the admin, Postgres, Redis or the TTS)`;
  return null;
}

const isLocal = (host: string) => host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "0.0.0.0";
/** the project a path is under (`/projects/<name>…`), for telling apps apart on shared ports */
const projectOfPath = (p: string) => /^\/projects\/([^/]+)/.exec(p)?.[1] ?? null;
const appLabel = (a: Pick<AppRow, "project" | "app">) => `${a.project}/${a.app || "(root)"}`;

/** Every problem, most serious first. */
export function findProblems(input: { routes: Route[]; servers: ServerInfo[]; listeners: ListenerInfo[]; apps: AppRow[]; policy?: PortPolicy }): Problem[] {
  const { routes, servers, listeners, apps } = input;
  const policy = input.policy ?? DEFAULT_PORT_POLICY;
  const out: Problem[] = [];
  const byPort = new Map(listeners.map((l) => [l.port, l]));

  // two apps on one port (the admin's own data: the drones/Access 4001 case)
  const appsByPort = new Map<number, AppRow[]>();
  for (const a of apps) if (a.port !== null) appsByPort.set(a.port, [...(appsByPort.get(a.port) ?? []), a]);
  for (const [port, list] of appsByPort) {
    if (list.length < 2) continue;
    out.push({
      kind: "duplicate-port", level: "error", port, appIds: list.map((a) => a.appId),
      routeIds: routes.filter((r) => r.upstream.kind === "proxy" && r.upstream.port === port).map((r) => r.id),
      message: `Port ${port} is given to ${list.length} apps (${list.map(appLabel).join(", ")}): one server answers for all of them.`,
    });
  }
  // a hand-written route sharing a port with another project's routes
  const projectsByPort = new Map<number, Set<string>>();
  for (const r of routes) {
    if (r.upstream.kind !== "proxy" || !isLocal(r.upstream.host)) continue;
    const pr = projectOfPath(r.path);
    if (!pr) continue;
    projectsByPort.set(r.upstream.port, (projectsByPort.get(r.upstream.port) ?? new Set()).add(pr));
  }
  // (and each app on its port, routed or not)
  for (const a of apps) if (a.port !== null) projectsByPort.set(a.port, (projectsByPort.get(a.port) ?? new Set()).add(a.project));
  for (const [port, prs] of projectsByPort) {
    // (two apps on it: already said, above)
    if (prs.size < 2 || (appsByPort.get(port)?.length ?? 0) >= 2) continue;
    out.push({
      kind: "duplicate-port", level: "warn", port,
      routeIds: routes.filter((r) => r.upstream.kind === "proxy" && r.upstream.port === port).map((r) => r.id),
      message: `Port ${port} serves the paths of ${prs.size} projects (${[...prs].join(", ")}).`,
    });
  }
  // the same path twice in one server
  const seenPath = new Map<string, Route>();
  for (const r of routes) {
    const key = `${r.serverId} ${r.modifier} ${r.path}`;
    const was = seenPath.get(key);
    if (was) {
      out.push({ kind: "duplicate-path", level: "error", routeIds: [was.id, r.id], message: `${r.modifier ? `${r.modifier} ` : ""}${r.path} is defined twice in one server (${was.file}:${was.line} and ${r.file}:${r.line}); nginx -t refuses that.` });
    } else seenPath.set(key, r);
  }
  // a route to a port nothing listens on
  for (const r of routes) {
    if (r.upstream.kind !== "proxy" || !isLocal(r.upstream.host) || byPort.has(r.upstream.port)) continue;
    const app = apps.find((a) => a.port === (r.upstream as { port: number }).port && a.mount === r.path);
    out.push({
      kind: "dead-route", level: app && !app.running ? "info" : "warn", port: r.upstream.port, routeIds: [r.id], appIds: app ? [app.appId] : undefined,
      message: `${r.path} → :${r.upstream.port}: nothing listens there${app ? (app.running ? "" : ` (${appLabel(app)} is stopped)`) : ""}.`,
    });
  }
  // a project's server that no route reaches
  const routedPorts = new Set(routes.flatMap((r) => (r.upstream.kind === "proxy" && isLocal(r.upstream.host) ? [r.upstream.port] : [])));
  const serverPorts = new Set(servers.flatMap((s) => s.listen.map((l) => l.port)));
  for (const l of listeners) {
    if (!l.project || routedPorts.has(l.port) || serverPorts.has(l.port)) continue;
    out.push({ kind: "unrouted", level: "info", port: l.port, message: `${l.project} listens on :${l.port}${l.process ? ` (${l.process}, pid ${l.pid})` : ""}, but no route leads there.` });
  }
  // a port outside the range
  for (const a of apps) {
    if (a.port === null) continue;
    const why = portAllowed(a.port, policy);
    if (why) out.push({ kind: "port-range", level: "warn", port: a.port, appIds: [a.appId], message: `${appLabel(a)}: ${why}.` });
  }
  const rank = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || (a.port ?? 0) - (b.port ?? 0));
}

/** A reason a port change can't go ahead (`block`), or one to know first (`warn`). */
export type Conflict = { level: "block" | "warn"; message: string };

/** Before giving `appId` the port `port`: another app has it, a live process holds it, it's outside the range. */
export function portChangeConflicts(appId: number, port: number | null, apps: AppRow[], listeners: ListenerInfo[], policy: PortPolicy = DEFAULT_PORT_POLICY): Conflict[] {
  const me = apps.find((a) => a.appId === appId);
  if (!me) return [{ level: "block", message: "No such app." }];
  if (port === null) return me.port === null ? [] : [{ level: "warn", message: `${me.mount} will no longer be routed.` }];
  const out: Conflict[] = [];
  const why = portAllowed(port, policy);
  if (why) out.push({ level: "block", message: why });
  for (const other of apps) {
    if (other.appId !== appId && other.port === port) out.push({ level: "block", message: `Port ${port} is already ${appLabel(other)}'s.` });
  }
  const l = listeners.find((x) => x.port === port);
  if (l && l.project !== me.project) {
    out.push({ level: "block", message: `Port ${port} is held now by ${l.process ?? "a process"}${l.pid ? ` (pid ${l.pid})` : ""}${l.project ? `, ${l.project}'s` : ""}.` });
  } else if (l && port !== me.port) {
    out.push({ level: "warn", message: `${me.project}'s own server already listens on ${port}.` });
  }
  if (me.running && port !== me.port) out.push({ level: "warn", message: `${appLabel(me)} runs on ${me.port}: restart it to move it to ${port}.` });
  return out;
}

// ---- the generated include ---------------------------------------------------

/** One app's line in the generated include: its mount path and port. */
export type ConfRow = { project: string; app: string; port: number | null; mount: string };

// Slugs come from directory names; only allow a safe charset in generated
// config to prevent any Nginx directive injection.
const SAFE_SLUG = /^[A-Za-z0-9._-]+$/;
const SAFE_MOUNT = /^\/[A-Za-z0-9._/-]*$/;

function isValidPort(p: number | null): p is number {
  return typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535;
}

/**
 * The generated projects.conf for these apps (sorted as given). A port two apps
 * share is written once per app, as before, but flagged in a comment above each
 * (T242): the admin refuses new duplicates; old ones show on the Nginx page.
 */
export function renderProjectsConfText(rows: ConfRow[]): string {
  const count = new Map<number, string[]>();
  for (const r of rows) if (isValidPort(r.port)) count.set(r.port, [...(count.get(r.port) ?? []), `${r.project}/${r.app || "(root)"}`]);
  const blocks: string[] = [
    "# GENERATED from the admin DB (apps.port). Do not edit by hand;",
    "# it is overwritten whenever a port is changed in the admin UI.",
    "# The prefix is PRESERVED (no strip): each app must set its Next basePath",
    "# to the mount path shown in the comment.",
    "",
  ];
  for (const r of rows) {
    if (!isValidPort(r.port)) continue;
    if (!SAFE_SLUG.test(r.project)) continue;
    if (r.app !== "" && !SAFE_SLUG.test(r.app)) continue;
    if (!SAFE_MOUNT.test(r.mount) || r.mount.includes("..")) continue;
    const shared = count.get(r.port) ?? [];
    if (shared.length > 1) blocks.push(`# DUPLICATE PORT ${r.port}: shared with ${shared.filter((x) => x !== `${r.project}/${r.app || "(root)"}`).join(", ")} — give each app its own`);
    blocks.push(
      `# ${r.project}/${r.app || "(root)"} — app basePath must be '${r.mount}'`,
      // No trailing slash on proxy_pass -> the full request URI is preserved.
      `location ${r.mount} { proxy_pass http://127.0.0.1:${r.port}; }`,
      "",
    );
  }
  return blocks.join("\n");
}

export type DiffLine = { op: " " | "+" | "-"; text: string };

/** A line diff (LCS), for previewing the generated include before it is applied. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n"), b = after.split("\n");
  const n = a.length, m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: " ", text: a[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: "-", text: a[i++] });
    else out.push({ op: "+", text: b[j++] });
  }
  while (i < n) out.push({ op: "-", text: a[i++] });
  while (j < m) out.push({ op: "+", text: b[j++] });
  return out;
}

// ---- applying ----------------------------------------------------------------

export type ApplyIO = {
  read: () => Promise<string | null>;
  write: (text: string) => Promise<void>;
  /** `nginx -t && reload`, via the root helper; throws with nginx's report when the test fails */
  reload: () => Promise<string>;
};
export type ApplyResult = { ok: boolean; message: string; rolledBack?: boolean };

/**
 * Write the new include and reload; if the reload fails (nginx -t refused it, so
 * the running config is unchanged), put the previous file back, so the next
 * reload by anyone doesn't pick up the bad one.
 */
export async function applyWithRollback(next: string, io: ApplyIO): Promise<ApplyResult> {
  const prev = await io.read();
  try {
    await io.write(next);
  } catch (e) {
    return { ok: false, message: `writing the include failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    return { ok: true, message: (await io.reload()).trim() || "nginx reloaded" };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (prev === null) return { ok: false, message: `nginx reload failed: ${why}` };
    try {
      await io.write(prev);
      return { ok: false, rolledBack: true, message: `nginx reload failed, the previous include is back: ${why}` };
    } catch (e2) {
      return { ok: false, message: `nginx reload failed (${why}) and restoring the previous include failed too: ${e2 instanceof Error ? e2.message : String(e2)}` };
    }
  }
}
