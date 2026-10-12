import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { CityBounds } from "@/lib/city-layout";

import { deskLine } from "./desks";
import { blades, cablePoints, coreColor, formatRate, GATE, gatewayAt, gatewayBox, gates, meters, overlap, placeGateway, plateSizes, portLabel, pulseSeconds, rackExtent, rackOf, serverExtent, serverObstacles } from "./server";

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
  it("the gateway (T214): sized to its ports, a gate each, inside its wall, left to right, no empty stretch", () => {
    const g = gatewayAt(0, 0, line.wu, 6), gs = gates(g, 6);
    assert.equal(gs.length, 6);
    for (let i = 1; i < 6; i++) assert.ok(gs[i].x0 > gs[i - 1].x1);
    assert.ok(gs[0].x0 > g.x0 && gs[5].x1 < g.x1 && g.x1 - gs[5].x1 < 1.2 * line.wu && gs.every((x) => x.h1 < g.h));
    assert.ok(gatewayAt(0, 0, line.wu, 3).x1 < g.x1, "fewer ports, a shorter wall");
    assert.equal(gates(gatewayAt(0, 0, line.wu, 6), 9).length, 6, "more ports than gates until laid out again: the rest counted, not drawn");
  });
  it("its plates: the port's number readable at the whole map's zoom (10 px at least) while it fits its gate; the service only from 7 px", () => {
    const g = gatewayAt(0, 0, line.wu, 6);
    for (const k of [0.5, 1, 2, 5, 20]) {
      const p = plateSizes(g, k);
      assert.ok(p.num * k >= Math.min(10, (GATE.w - 0.6) * g.wu * k / 2.48) - 1e-9, `number ${p.num * k} px at k ${k}`);
      assert.ok(4 * 0.62 * p.num <= (GATE.w - 0.6) * g.wu + 1e-9, "four digits fit the gate");
      assert.equal(p.service === null, 0.55 * g.wu * k < 7);
      assert.ok(p.h < 2.3 * g.wu, "over the gate, under the wall's top");
    }
  });
  it("placed behind the rack, overlapping nothing round it at the whole map's zoom: rack, readouts, its name, belts and packages, cities and their names", () => {
    for (const k of [0.8, 1.5, 3, 6]) {
      const obstacles = serverObstacles(r, line.belts, cities, k), g = placeGateway(r, obstacles, k, 6), box = gatewayBox(g, k);
      assert.ok(g.z1 < r.z0, `behind the rack (k ${k})`);
      obstacles.forEach((o, i) => assert.ok(!overlap(o, box), `clear of obstacle ${i} (k ${k})`));
      // (the cable: over the readouts and the rest, touching only the rack it ends on)
      cablePoints(g, r).slice(2, -2).forEach((p, i) => obstacles.slice(1).forEach((o, j) => assert.ok(!(p.x > o.x0 && p.x < o.x1 && p.y > o.y0 && p.y < o.y1), `cable point ${i} in obstacle ${j + 1} (k ${k})`)));
      const e = serverExtent(r, g, k);
      assert.ok(e.some((p) => p.x <= box.x0) && e.some((p) => p.y <= box.y0), "the fit takes it in");
    }
  });
  it("an obstacle where it would go: it moves on to the next clear place", () => {
    const k = 2, first = placeGateway(r, serverObstacles(r, line.belts, cities, k), k, 6);
    const blocked = [...serverObstacles(r, line.belts, cities, k), gatewayBox(first, k)];
    const next = placeGateway(r, blocked, k, 6);
    assert.ok(next.x0 !== first.x0 || next.z1 !== first.z1);
    assert.ok(!blocked.some((o) => overlap(o, gatewayBox(next, k))));
  });
  it("rates and port labels as people read them; the cable's pulse faster with more traffic", () => {
    assert.deepEqual([formatRate(340), formatRate(1234), formatRate(13_000), formatRate(400_000), formatRate(1_234_567), formatRate(25e6)], ["340 B/s", "1.2 kB/s", "13 kB/s", "400 kB/s", "1.2 MB/s", "25 MB/s"]);
    assert.deepEqual([portLabel({ port: 22, proto: "tcp", service: "ssh" }), portLabel({ port: 68, proto: "udp", service: "dhcp" }), portLabel({ port: 3000, proto: "tcp", service: "" })], ["22 ssh", "68/udp dhcp", "3000"]);
    assert.ok(pulseSeconds(0) > pulseSeconds(1e5) && pulseSeconds(1e5) > pulseSeconds(1e7) && pulseSeconds(1e9) === 0.5);
  });
});
