import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { defaultIface, parseNetDev, parseSs, publicIface, rateOf } from "./net-stats";

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
      { port: 22, proto: "tcp", service: "ssh", process: null, addrs: ["0.0.0.0", "::"] },
      { port: 68, proto: "udp", service: "dhcp", process: null, addrs: ["10.128.5.198"] },
      { port: 80, proto: "tcp", service: "http", process: null, addrs: ["0.0.0.0", "::"] },
      { port: 3000, proto: "tcp", service: "", process: null, addrs: ["0.0.0.0"] },
      { port: 5544, proto: "tcp", service: "docker-proxy", process: "docker-proxy", addrs: ["0.0.0.0"] },
      { port: 7000, proto: "tcp", service: "next-server", process: "next-server", addrs: ["*"] },
    ]);
  });
  it("leaves out loopback-only ports and lines that aren't sockets", () => {
    const ports = parseSs(`${SS}\nNetid State\n`).map((p) => p.port);
    for (const p of [53, 3002, 5432, 9000, 9001]) assert.ok(!ports.includes(p), String(p));
    assert.deepEqual(parseSs(""), []);
  });
});
