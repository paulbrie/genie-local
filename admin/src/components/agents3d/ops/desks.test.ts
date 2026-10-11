import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { CityBounds } from "@/lib/city-layout";

import { beltPlaces, PKG, SLOT } from "./belt";
import { deskLine, deskParts, SEAT_MAX } from "./desks";
import type { OpsCommit } from "./model";

// (two cities along x, as the layout lays them)
const cities: CityBounds[] = [
  { repo: "/r/admin", name: "admin", x: 0, z: 0, w: 40, d: 30 },
  { repo: "/r/trafficsim", name: "trafficsim", x: 44, z: 10, w: 56, d: 30 },
];
const commit = (hash: string, repo: string | null, by = "Tom", ms = 0): OpsCommit => ({ hash, label: hash, subject: hash, repo, by, ms, pushed: false });

describe("the Ops view's desks on the map's ground (T201)", () => {
  it("one seat per agent, in a row along x (parallel to the cities' edges) in front of the cities, centred on them", () => {
    const l = deskLine(cities, 6);
    assert.equal(l.seats.length, 6);
    assert.ok(l.seats.every((s) => s.z === l.seats[0].z), "one line of equal z: along the cities' front edges");
    assert.ok(l.seats[0].z > 40, "in front of the frontmost city (its front edge at z = 40)");
    for (let i = 1; i < 6; i++) assert.ok(l.seats[i].x > l.seats[i - 1].x);
    assert.ok(Math.abs((l.seats[0].x + l.seats[5].x) / 2 - 50) < 1e-9);
    assert.ok(l.seats[0].x >= 0 && l.seats[5].x <= 100);
    assert.ok(l.seats[1].x - l.seats[0].x <= SEAT_MAX + 1e-9, "a desk at the files' scale, however long the cities");
  });
  it("desks never overlap (a desk is 4.4 of its units long, a seat's room 7), and a small team keeps together", () => {
    const l = deskLine(cities, 6);
    assert.ok(l.seats[1].x - l.seats[0].x >= 4.4 * l.wu);
    const two = deskLine(cities, 2);
    assert.ok(two.seats[1].x - two.seats[0].x <= Math.min(SEAT_MAX, 100 / 4) + 1e-9);
  });
  it("a belt per city (T204): along its far side, its length, a gap behind it (from the viewer: desks, cities, belts)", () => {
    const l = deskLine(cities, 6), deskFar = l.seats[0].z - 3.6 * l.wu;
    assert.deepEqual(l.belts.map((b) => b.repo), ["/r/admin", "/r/trafficsim"]);
    l.belts.forEach((b, i) => {
      const c = cities[i];
      assert.deepEqual([b.x0, b.x1], [c.x, c.x + c.w]);
      assert.ok(b.z1 < c.z - 2 * l.wu && b.z0 < b.z1, "behind its city's far edge, with a gap");
    });
    assert.ok(deskFar > 40, "the desks clear of the cities");
    assert.equal(l.extent.length, 2 * 2 + 2);
  });
  it("the computer stands on the desk towards the map, the curve leaving its top", () => {
    const d = deskParts(1);
    const deskTop = Math.min(...d.top.top.map((p) => p.y)), ys = d.monitor.top.map((p) => p.y);
    assert.ok(deskTop < 0 && Math.min(...ys) < deskTop);
    assert.ok(d.beam.y >= Math.min(...ys) && d.beam.y <= Math.max(...ys));
  });
});

describe("the commits' belts (T201, T204)", () => {
  const line = deskLine(cities, 6), slot = SLOT * line.wu, half = (PKG * line.wu) / 2;
  it("each repo's packages on its own city's belt, the newest at the city's middle, the older ones a slot back each", () => {
    const p = beltPlaces([commit("a1", "/r/admin"), commit("a2", "/r/admin"), commit("t1", "/r/trafficsim")], line);
    assert.deepEqual([p.get("a2")?.belt.repo, p.get("a2")?.x], ["/r/admin", 20]);
    assert.ok(Math.abs(p.get("a1")!.x - (20 - slot)) < 1e-9);
    assert.deepEqual([p.get("t1")?.belt.repo, p.get("t1")?.x], ["/r/trafficsim", 72]);
  });
  it("a repo with no city on the map: no belt, not shown", () => {
    const p = beltPlaces([commit("x", "/elsewhere"), commit("n", null)], line);
    assert.equal(p.size, 0);
  });
  it("a full belt keeps its newest; never two closer than a slot, all on their belt", () => {
    const many = Array.from({ length: 40 }, (_, i) => commit(`c${String(i).padStart(2, "0")}`, "/r/admin"));
    const p = beltPlaces(many, line), b = line.belts[0];
    const xs = [...p.values()].map((v) => v.x).sort((a, z) => a - z);
    assert.equal(xs.length, Math.floor((b.x1 - b.x0 - 2 * half) / slot) + 1);
    assert.ok(p.has("c39") && !p.has("c00"), "the newest kept, the oldest gone");
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= slot - 1e-9);
    assert.ok(xs[0] >= b.x0 + half - 1e-9 && xs[xs.length - 1] <= b.x1 - half + 1e-9);
  });
});
