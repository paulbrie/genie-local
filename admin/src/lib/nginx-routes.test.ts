/**
 * The Nginx routes as data (T242): parsing with includes, the routes, `ss`, the
 * problems (the drones/Access 4001 case), the port-change guard, the generated
 * include and its diff, and the rollback when nginx -t refuses.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  applyWithRollback, diffLines, expandIncludes, extractRoutes, findProblems, listenerDetail, listenerName, parseNginx, parseProxyPass, parseSsListeners,
  portAllowed, portChangeConflicts, renderProjectsConfText, serviceOfCgroup, type AppRow, type ListenerInfo,
} from "./nginx-routes";

const NGINX_CONF = `
user www-data;
http {
  include /etc/nginx/conf.d/*.conf;   # maps
  include /etc/nginx/sites-enabled/*;
}`;
const FT_ADMIN = `
server {
    listen 3000;
    listen [::]:3000;
    server_name _;
    location /admin { proxy_pass http://127.0.0.1:3002; }
    location = / { return 302 /admin; }
    location /vscode/ {
        auth_request /vscode-authcheck;
        proxy_pass http://127.0.0.1:13337/;
    }
    location = /vscode-authcheck { internal; proxy_pass http://127.0.0.1:3002/admin/api/authcheck; }
    location @vscode_login { return 302 /admin/login; }
    location /projects/oracle/auth/ { proxy_pass http://127.0.0.1:8080/auth/; }
    location /projects/oracle { proxy_pass http://127.0.0.1:3020; }
    include /opt/project/admin/nginx/projects.conf;
}`;
const TLS_SITE = `
server {
  listen 443 ssl default_server;
  server_name app.example.com www.example.com;
  ssl_certificate /etc/ssl/a.pem;
  location / { root /var/www/html; try_files $uri =404; }
  location /sock { proxy_pass http://unix:/run/app.sock:/; }
}`;
const PROJECTS = `# GENERATED
# acccess/(root) — app basePath must be '/projects/acccess'
location /projects/acccess { proxy_pass http://127.0.0.1:4001; }
# eu-funding-drones/(root)
location /projects/eu-funding-drones { proxy_pass http://127.0.0.1:4001; }
location /projects/garden { proxy_pass http://127.0.0.1:4000; }
`;
const FILES: Record<string, string> = {
  "/etc/nginx/conf.d/connection_upgrade.conf": "map $http_upgrade $connection_upgrade { default upgrade; '' close; }",
  "/etc/nginx/sites-enabled/ft-admin": FT_ADMIN,
  "/etc/nginx/sites-enabled/tls": TLS_SITE,
  "/opt/project/admin/nginx/projects.conf": PROJECTS,
};
const resolve = async (pattern: string) => {
  const re = new RegExp(`^${pattern.replace(/[.]/g, "\\.").replace(/\*/g, "[^/]*")}$`);
  return Object.keys(FILES).filter((f) => re.test(f)).sort().map((file) => ({ file, text: FILES[file] }));
};
const GENERATED = (f: string) => f.endsWith("/projects.conf");

async function load() {
  const top = await expandIncludes(parseNginx(NGINX_CONF, "/etc/nginx/nginx.conf"), resolve);
  return extractRoutes(top, GENERATED);
}

const APPS: AppRow[] = [
  { appId: 1, project: "acccess", app: "", port: 4001, mount: "/projects/acccess", running: true },
  { appId: 2, project: "eu-funding-drones", app: "", port: 4001, mount: "/projects/eu-funding-drones", running: false },
  { appId: 3, project: "garden", app: "", port: 4000, mount: "/projects/garden", running: false },
  { appId: 4, project: "chetani", app: "", port: null, mount: "/projects/chetani", running: false },
];
const SS = `LISTEN 0 511 *:4001 *:* users:(("next-server (v1",pid=1852670,fd=22))
LISTEN 0 511 127.0.0.1:3002 0.0.0.0:* users:(("node",pid=900,fd=20))
LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*
LISTEN 0 4096 [::]:3000 [::]:*
LISTEN 0 511 *:7301 *:* users:(("next-server (v1",pid=777,fd=21))`;
const LISTENERS: ListenerInfo[] = parseSsListeners(SS).map((l) => ({
  ...l,
  cwd: l.pid === 1852670 ? "/opt/project/projects/acccess" : l.pid === 777 ? "/opt/project/projects/chetani" : null,
  project: l.pid === 1852670 ? "acccess" : l.pid === 777 ? "chetani" : null,
}));

describe("the nginx routes (T242)", () => {
  it("parses directives, blocks, comments and quotes, and follows includes with their files", async () => {
    const top = parseNginx(`a b "c d";  # x\nhttp { e 'f;g'; }`, "f");
    assert.deepEqual(top.map((d) => [d.name, d.args, d.line]), [["a", ["b", "c d"], 1], ["http", [], 2]]);
    assert.deepEqual(top[1].block?.[0].args, ["f;g"]);
    const { servers, routes } = await load();
    assert.equal(servers.length, 2);
    assert.equal(routes.filter((r) => r.generated).length, 3);
    assert.ok(routes.every((r) => r.file.startsWith("/")));
  });

  it("tells listen, names and TLS, and each location's upstream", async () => {
    const { servers, routes } = await load();
    const [ft, tls] = servers;
    assert.deepEqual(ft.listen.map((l) => l.port), [3000, 3000]);
    assert.deepEqual(ft.names, ["_"]);
    assert.equal(ft.tls, false);
    assert.deepEqual(tls.names, ["app.example.com", "www.example.com"]);
    assert.ok(tls.tls && tls.listen[0].ssl && tls.listen[0].defaultServer);
    const by = (p: string) => routes.find((r) => r.path === p)!;
    assert.deepEqual(by("/admin").upstream, { kind: "proxy", scheme: "http", host: "127.0.0.1", port: 3002, uri: "", raw: "http://127.0.0.1:3002" });
    assert.equal(by("/").modifier, "=");
    assert.deepEqual(by("/").upstream, { kind: "redirect", status: 302, to: "/admin" });
    assert.equal(by("@vscode_login").modifier, "@");
    assert.equal(by("/vscode-authcheck").upstream.kind, "proxy");
    assert.deepEqual(by("/sock").upstream, { kind: "socket", path: "/run/app.sock", raw: "http://unix:/run/app.sock:/" });
    assert.equal(routes.find((r) => r.serverId === tls.id && r.path === "/")!.upstream.kind, "static");
    assert.equal(parseProxyPass("http://$backend").kind, "other");
    assert.deepEqual(parseProxyPass("https://example.com/x"), { kind: "proxy", scheme: "https", host: "example.com", port: 443, uri: "/x", raw: "https://example.com/x" });
  });

  it("reads ss: a port once, the pid and process when they are ours", () => {
    const l = parseSsListeners(SS);
    assert.deepEqual(l.map((x) => x.port), [3000, 3002, 4001, 7301]);
    assert.deepEqual(l.find((x) => x.port === 4001), { addr: "*", port: 4001, pid: 1852670, process: "next-server (v1" });
    assert.equal(l.find((x) => x.port === 3000)!.pid, null);
  });

  it("names what listens by its project, its systemd unit, its directory or command: never a thread's name", () => {
    const l = (x: Partial<ListenerInfo>): ListenerInfo => ({ addr: "*", port: 1, pid: 1, process: "MainThread", cwd: null, project: null, ...x });
    assert.equal(serviceOfCgroup("0::/system.slice/admin-dev.service\n"), "admin-dev");
    assert.equal(serviceOfCgroup("0::/user.slice/user-1000.slice/session-3.scope"), null);
    // a project's dev server runs in admin's unit (the runner spawned it): the project first
    assert.equal(listenerName(l({ cwd: "/opt/project/projects/acccess", project: "acccess", service: "admin" })), "acccess");
    assert.equal(listenerName(l({ cwd: "/opt/project/admin", service: "admin" })), "admin");
    assert.equal(listenerName(l({ cwd: "/opt/project/admin", service: "admin-dev" })), "admin-dev");
    assert.equal(listenerName(l({ cwd: "/opt/project", service: "code-server" })), "code-server");
    assert.equal(listenerName(l({ cwd: "/srv/tool" })), "tool");
    assert.equal(listenerName(l({ command: "/usr/bin/redis-server *:6379" })), "redis-server");
    // a tool started from the admin's terminal (its unit not set: not the unit's own server), run by node
    assert.equal(listenerName(l({ cwd: "/opt/project/admin", command: "/usr/bin/node /opt/tools/agent-browser.js" })), "agent-browser.js");
    assert.equal(listenerName(l({ pid: null, process: null })), "a process");
    assert.equal(listenerDetail(l({ service: "admin-dev", pid: 42 })), "admin-dev.service · pid 42");
    assert.equal(listenerDetail(l({ command: "/usr/bin/node /opt/project/admin/server.mjs", pid: 42 })), "node server.mjs · pid 42");
    assert.equal(listenerDetail(l({ pid: 42 })), "pid 42");
    assert.equal(listenerDetail(l({ pid: null, process: null })), "not ours");
  });

  it("flags the drones/Access 4001 case, dead routes, unrouted servers, duplicate paths and ports out of range", async () => {
    const { servers, routes } = await load();
    const problems = findProblems({ routes, servers, listeners: LISTENERS, apps: [...APPS, { appId: 5, project: "x", app: "", port: 80, mount: "/projects/x", running: false }] });
    const dup = problems.find((p) => p.kind === "duplicate-port" && p.port === 4001)!;
    assert.equal(dup.level, "error");
    assert.deepEqual(dup.appIds, [1, 2]);
    assert.equal(dup.routeIds!.length, 2);
    // garden routed to 4000, stopped: info; oracle's 3020 and 8080, hand-written, nothing there: warn
    assert.equal(problems.find((p) => p.kind === "dead-route" && p.port === 4000)!.level, "info");
    assert.equal(problems.find((p) => p.kind === "dead-route" && p.port === 3020)!.level, "warn");
    // chetani listens on 7301 with no route (its port isn't set)
    assert.match(problems.find((p) => p.kind === "unrouted")!.message, /chetani listens on :7301/);
    assert.ok(problems.some((p) => p.kind === "port-range" && p.port === 80));
    assert.equal(problems[0].level, "error");
    // a hand-written route on an app's port, another project's (oracle and trafficsim2 on 3020)
    const shared = findProblems({ routes, servers, listeners: LISTENERS, apps: [...APPS, { appId: 6, project: "trafficsim2", app: "", port: 3020, mount: "/projects/trafficsim2", running: false }] });
    assert.match(shared.find((p) => p.kind === "duplicate-port" && p.port === 3020)!.message, /2 projects \(oracle, trafficsim2\)|2 projects \(trafficsim2, oracle\)/);
    const twice = extractRoutes(parseNginx(`server { location /a { proxy_pass http://127.0.0.1:1; } location /a { return 404; } }`, "f"), () => false);
    assert.equal(findProblems({ ...twice, listeners: [], apps: [] }).filter((p) => p.kind === "duplicate-path").length, 1);
  });

  it("guards a port change: another app's port, a live process's, outside the range; a running app warned", () => {
    assert.match(portChangeConflicts(2, 4001, APPS, LISTENERS)[0].message, /already acccess\/\(root\)'s/);
    assert.ok(portChangeConflicts(2, 4001, APPS, LISTENERS).every((c) => c.level === "block"));
    assert.deepEqual(portChangeConflicts(2, 4006, APPS, LISTENERS), []);
    assert.match(portChangeConflicts(3, 7301, APPS, LISTENERS)[0].message, /held now by next-server.*chetani's/);
    assert.equal(portChangeConflicts(4, 7301, APPS, LISTENERS)[0].level, "warn"); // chetani's own server
    assert.equal(portChangeConflicts(3, 3002, APPS, LISTENERS)[0].level, "block");
    assert.match(portChangeConflicts(1, 4006, APPS, LISTENERS).map((c) => c.message).join(), /restart it/);
    assert.equal(portAllowed(4006), null);
    assert.ok(portAllowed(3000) && portAllowed(22) && portAllowed(70000));
    assert.equal(portChangeConflicts(99, 4006, APPS, LISTENERS)[0].level, "block");
  });

  it("renders the generated include as before, a shared port flagged, unsafe slugs and mounts dropped", () => {
    const text = renderProjectsConfText(APPS.map(({ project, app, port, mount }) => ({ project, app, port, mount })));
    assert.match(text, /^# GENERATED from the admin DB/);
    assert.match(text, /location \/projects\/acccess \{ proxy_pass http:\/\/127\.0\.0\.1:4001; \}/);
    assert.match(text, /# DUPLICATE PORT 4001: shared with eu-funding-drones\/\(root\)/);
    assert.match(text, /# DUPLICATE PORT 4001: shared with acccess\/\(root\)/);
    assert.ok(!text.includes("chetani"));
    const clean = renderProjectsConfText([{ project: "garden", app: "", port: 4000, mount: "/projects/garden" }, { project: "a;b", app: "", port: 1, mount: "/x" }, { project: "c", app: "", port: 2, mount: "/x { }" }]);
    assert.ok(!clean.includes("DUPLICATE") && !clean.includes("a;b") && !clean.includes("{ }"));
  });

  it("diffs line by line", () => {
    const d = diffLines("a\nb\nc", "a\nB\nc\nd");
    assert.deepEqual(d.map((x) => x.op + x.text), [" a", "-b", "+B", " c", "+d"]);
  });

  it("applies, and puts the previous include back when nginx -t refuses", async () => {
    let file: string | null = "old";
    const io = (ok: boolean) => ({
      read: async () => file,
      write: async (t: string) => { file = t; },
      reload: async () => { if (!ok) throw new Error("nginx: [emerg] duplicate location"); return "nginx reloaded"; },
    });
    assert.deepEqual(await applyWithRollback("new", io(true)), { ok: true, message: "nginx reloaded" });
    assert.equal(file, "new");
    const r = await applyWithRollback("bad", io(false));
    assert.equal(r.ok, false);
    assert.equal(r.rolledBack, true);
    assert.match(r.message, /duplicate location/);
    assert.equal(file, "new");
  });
});
