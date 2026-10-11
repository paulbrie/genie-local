import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { CityBounds } from "@/lib/city-layout";

import { deskLine } from "./desks";
import { blades, coreColor, formatRate, meters, netBoxOf, portLabel, pulseSeconds, rackExtent, rackOf, serverExtent, sockets } from "./server";

const cities: CityBounds[] = [
  { repo: "/r/admin", name: "admin", x: 0, z: 0, w: 40, d: 30 },
  { repo: "/r/trafficsim", name: "trafficsim", x: 44, z: 10, w: 56, d: 30 },
];

describe("our server beyond the belts (T209)", () => {
  const line = deskLine(cities, 6), r = rackOf(cities, line.belts, line.wu);
  it("stands behind the farthest belt, centred on the cities", () => {
    assert.ok(r.z1 < Math.min(...line.belts.map((b) => b.z0)), "beyond every belt");
    assert.ok(Math.abs((r.x0 + r.x1) / 2 - 50) < 1e-9);
    assert.equal(rackExtent(r).length, 4);
  });
  it("a blade a core on its front, top to bottom, inside the rack, none overlapping", () => {
    const b = blades(r, 16);
    assert.equal(b.length, 16);
    for (let i = 1; i < 16; i++) assert.ok(b[i].h1 < b[i - 1].h0, `blade ${i} under blade ${i - 1}`);
    assert.ok(b[0].h1 < r.h && b[15].h0 > 0 && b.every((x) => x.x0 > r.x0 && x.x1 < r.x1));
  });
  it("three meters on its side, top to bottom, inside it", () => {
    const m = meters(r);
    assert.equal(m.length, 3);
    assert.ok(m[1].h1 < m[0].h0 && m[2].h1 < m[1].h0 && m[2].h0 > 0 && m.every((x) => x.z0 > r.z0 && x.z1 < r.z1));
  });
  it("a core's colour: dark idle, amber at 70 %, red at 90 % and over; grey without data", () => {
    assert.equal(coreColor(0), "rgb(30,41,59)");
    assert.equal(coreColor(70), "rgb(245,158,11)");
    assert.equal(coreColor(95), "rgb(239,68,68)");
    assert.equal(coreColor(null), "#1f2937");
  });
  it("the network box (T209b): left of the rack, level with its front, a socket a port top to bottom inside it", () => {
    const b = netBoxOf(r, 6), s = sockets(b, 6);
    assert.ok(b.x1 < r.x0 && b.z1 === r.z1);
    for (let i = 1; i < 6; i++) assert.ok(s[i].h1 < s[i - 1].h0);
    assert.ok(s[5].h0 > 0 && s[0].h1 < b.h && s.every((x) => x.x0 > b.x0 && x.x1 < b.x1));
    assert.ok(netBoxOf(r, 12).h > netBoxOf(r, 2).h, "as tall as its ports need");
    assert.equal(serverExtent(r).length, rackExtent(r).length + 2);
  });
  it("rates and port labels as people read them; the cable's pulse faster with more traffic", () => {
    assert.deepEqual([formatRate(340), formatRate(1234), formatRate(13_000), formatRate(400_000), formatRate(1_234_567), formatRate(25e6)], ["340 B/s", "1.2 kB/s", "13 kB/s", "400 kB/s", "1.2 MB/s", "25 MB/s"]);
    assert.deepEqual([portLabel({ port: 22, proto: "tcp", service: "ssh" }), portLabel({ port: 68, proto: "udp", service: "dhcp" }), portLabel({ port: 3000, proto: "tcp", service: "" })], ["22 ssh", "68/udp dhcp", "3000"]);
    assert.ok(pulseSeconds(0) > pulseSeconds(1e5) && pulseSeconds(1e5) > pulseSeconds(1e7) && pulseSeconds(1e9) === 0.5);
  });
});
