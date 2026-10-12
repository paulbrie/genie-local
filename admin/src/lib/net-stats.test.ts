import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { defaultIface, parseDockerPs, parseNetDev, parseNginxListens, parseSs, parseSystemdSockets, publicIface, rateOf } from "./net-stats";

// (this box's own files, trimmed)
const DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 11148397090 11614791    0    0    0     0          0         0 11148397090 11614791    0    0    0     0       0          0
  ens3: 3800045104 19275372    0    0    0     0          0         0 105838557536 14665691    0    0    0     0       0          0
br-538a51835a2a:   23160      78    0    0    0     0          0         0    12547     107    0    0    0     0       0          0
docker0:      84       3    0    0    0     0          0         0      580       6    0    0    0     0       0          0
`;
const ROUTE = `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
ens3	01010101	0105800A	0007	0	0	100	FFFFFFFF	0	0	0
ens4	00000000	0105800B	0003	0	0	200	00000000	0	0	0
ens3	00000000	0105800A	0003	0	0	100	00000000	0	0	0
`;
const SS = `udp UNCONN 0      0             127.0.0.54:53    0.0.0.0:*
udp UNCONN 0      0          127.0.0.53%lo:53    0.0.0.0:*
udp UNCONN 0      0      10.128.5.198%ens3:68    0.0.0.0:*
tcp LISTEN 0      511              0.0.0.0:3000  0.0.0.0:*
tcp LISTEN 0      511            127.0.0.1:3002  0.0.0.0:* users:(("MainThread",pid=3652572,fd=27))
tcp LISTEN 0      511              0.0.0.0:80    0.0.0.0:*
tcp LISTEN 0      4096             0.0.0.0:22    0.0.0.0:*
tcp LISTEN 0      200            127.0.0.1:5432  0.0.0.0:*
tcp LISTEN 0      4096             0.0.0.0:5544  0.0.0.0:* users:(("docker-proxy",pid=1234,fd=4))
tcp LISTEN 0      511                 [::]:80       [::]:*
tcp LISTEN 0      4096                [::]:22       [::]:*
tcp LISTEN 0      511                    *:7000        *:* users:(("next-server (v1",pid=99,fd=21))
tcp LISTEN 0      511                [::1]:9000     [::]:*
tcp LISTEN 0      511   [::ffff:127.0.0.1]:9001     [::]:*
`;

describe("bandwidth on the public interface (T211)", () => {
  it("reads each interface's byte counters", () => {
    const d = parseNetDev(DEV);
    assert.deepEqual(d.get("ens3"), { rx: 3800045104, tx: 105838557536 });
    assert.equal(d.size, 4);
  });
  it("measures the default route's interface (the lowest metric), else the busiest real one", () => {
    assert.equal(defaultIface(ROUTE), "ens3");
    assert.equal(publicIface(ROUTE, parseNetDev(DEV)), "ens3");
    assert.equal(publicIface("", parseNetDev(DEV)), "ens3", "no route: not lo, not docker's");
    assert.equal(publicIface("", parseNetDev(DEV.replace(/ {2}ens3:.*\n/, ""))), null);
  });
  it("gives bytes/s between two readings, 0 when a counter went back", () => {
    const a = { t: 1000, b: { rx: 1000, tx: 5000 } };
    assert.deepEqual(rateOf(a, { t: 3000, b: { rx: 3000, tx: 9000 } }), { t: 3000, inBps: 1000, outBps: 2000 });
    assert.deepEqual(rateOf(a, { t: 3000, b: { rx: 10, tx: 9000 } }), { t: 3000, inBps: 0, outBps: 2000 });
  });
});

describe("public ports (T211)", () => {
  it("lists the ports on a non-loopback address, IPv4 and IPv6 as one, named", () => {
    assert.deepEqual(parseSs(SS), [
      { port: 22, proto: "tcp", service: "ssh", process: null, addrs: ["0.0.0.0", "::"], tech: { name: "ssh", via: "port" } },
      { port: 68, proto: "udp", service: "dhcp", process: null, addrs: ["10.128.5.198"], tech: { name: "dhcp", via: "port" } },
      { port: 80, proto: "tcp", service: "http", process: null, addrs: ["0.0.0.0", "::"], tech: { name: "http", via: "port" } },
      { port: 3000, proto: "tcp", service: "", process: null, addrs: ["0.0.0.0"], tech: null },
      { port: 5544, proto: "tcp", service: "docker-proxy", process: "docker-proxy", addrs: ["0.0.0.0"], tech: { name: "docker-proxy", via: "process" } },
      { port: 7000, proto: "tcp", service: "next-server", process: "next-server", addrs: ["*"], tech: { name: "next", via: "process" } },
    ]);
  });
  it("leaves out loopback-only ports and lines that aren't sockets", () => {
    const ports = parseSs(`${SS}\nNetid State\n`).map((p) => p.port);
    for (const p of [53, 3002, 5432, 9000, 9001]) assert.ok(!ports.includes(p), String(p));
    assert.deepEqual(parseSs(""), []);
  });
});

// (this box's own output: `systemctl list-sockets --all --show-types --no-legend --full`, `docker ps --format …`, nginx's sites)
const SOCKETS = `0.0.0.0:22                             Stream           ssh.socket                      ssh.service
@/org/kernel/linux/storage/multipathd  Stream           multipathd.socket               multipathd.service
[::]:22                                Stream           ssh.socket                      ssh.service
audit 1                                Netlink          systemd-journald-audit.socket   systemd-journald.service
/dev/rfkill                            Special          systemd-rfkill.socket           systemd-rfkill.service
/run/dbus/system_bus_socket            Stream           dbus.socket                     dbus.service
`;
const DOCKER = `trafficsim-db-1\tpostgres:16-alpine\t0.0.0.0:5544->5432/tcp, [::]:5544->5432/tcp
kokoro-tts\tghcr.io/remsky/kokoro-fastapi-cpu:latest\t127.0.0.1:8880->8880/tcp
quiet\tredis:7\t6379/tcp
`;
const SITES = [
  { name: "ft-admin", text: "server {\n    listen 3000;\n    listen [::]:3000;\n    server_name _;\n}\n" },
  { name: "default", text: "server {\n\tlisten 80 default_server;\n\tlisten [::]:80 default_server;\n\t# listen 443 ssl default_server;\n}\n#\tlisten 8443;\n" },
];

describe("what serves each public port, told without root (T218)", () => {
  it("reads systemd's inet socket units", () => {
    assert.deepEqual([...parseSystemdSockets(SOCKETS)], [["tcp:22", { name: "ssh", via: "systemd", detail: "ssh.socket" }]]);
  });
  it("reads docker's published ports, named by image", () => {
    const d = parseDockerPs(DOCKER);
    assert.deepEqual(d.get("tcp:5544"), { name: "postgres", via: "docker", detail: "trafficsim-db-1 · postgres:16-alpine" });
    assert.equal(d.get("tcp:8880")?.name, "kokoro-fastapi-cpu");
    assert.equal(d.has("tcp:6379"), false, "exposed, not published");
    assert.deepEqual([...parseDockerPs("web\tnginx:1\t0.0.0.0:8000-8002->8000-8002/tcp")].map(([k]) => k), ["tcp:8000", "tcp:8001", "tcp:8002"]);
  });
  it("reads nginx's listen lines only, not the commented ones", () => {
    assert.deepEqual([...parseNginxListens(SITES)], [
      ["tcp:3000", { name: "nginx", via: "nginx", detail: "ft-admin" }],
      ["tcp:80", { name: "nginx", via: "nginx", detail: "default" }],
    ]);
    assert.deepEqual([...parseNginxListens([{ name: "h3", text: "listen 443 quic reuseport;\nlisten 127.0.0.1:8080;" }])].map(([k]) => k), ["udp:443", "tcp:8080"]);
  });
  it("names every public port here: docker, then our process, systemd, nginx, the well-known port", () => {
    const hints = { docker: parseDockerPs(DOCKER), systemd: parseSystemdSockets(SOCKETS), nginx: parseNginxListens(SITES) };
    const by = new Map(parseSs(SS, hints).map((p) => [`${p.proto}:${p.port}`, p]));
    assert.deepEqual(by.get("tcp:22")?.tech, { name: "ssh", via: "systemd", detail: "ssh.socket" });
    assert.deepEqual(by.get("tcp:80")?.tech, { name: "nginx", via: "nginx", detail: "default" });
    assert.deepEqual(by.get("tcp:3000")?.tech, { name: "nginx", via: "nginx", detail: "ft-admin" });
    assert.equal(by.get("tcp:3000")?.service, "nginx", "a blank service takes the tech's name");
    assert.deepEqual(by.get("tcp:5544")?.tech, { name: "postgres", via: "docker", detail: "trafficsim-db-1 · postgres:16-alpine" });
    assert.deepEqual(by.get("tcp:7000")?.tech, { name: "next", via: "process" });
    assert.deepEqual(by.get("udp:68")?.tech, { name: "dhcp", via: "port" });
  });
});
