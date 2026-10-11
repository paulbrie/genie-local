import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { CityBounds } from "@/lib/city-layout";

import { deskLine } from "./desks";
import { blades, coreColor, meters, rackExtent, rackOf } from "./server";

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
});
