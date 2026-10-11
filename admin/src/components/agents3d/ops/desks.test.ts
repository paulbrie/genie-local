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
  it("the belt runs the cities' length behind the seats, between the desks and the cities", () => {
    const l = deskLine(cities, 6), deskFar = l.seats[0].z - 3.6 * l.wu;
    assert.ok(l.belt.x0 < 0 && l.belt.x1 > 100);
    assert.ok(l.belt.z0 > 40 && l.belt.z1 < deskFar, "clear of the cities and of the desks");
    assert.equal(l.extent.length, 4);
  });
  it("the computer stands on the desk towards the map, the curve leaving its top", () => {
    const d = deskParts(1);
    const deskTop = Math.min(...d.top.top.map((p) => p.y)), ys = d.monitor.top.map((p) => p.y);
    assert.ok(deskTop < 0 && Math.min(...ys) < deskTop);
    assert.ok(d.beam.y >= Math.min(...ys) && d.beam.y <= Math.max(...ys));
  });
});

describe("the commits' belt (T201)", () => {
  const line = deskLine(cities, 6), slot = SLOT * line.wu;
  it("each repo's packages queue back from its city's middle, the newest in front", () => {
    const p = beltPlaces([commit("a1", "/r/admin"), commit("a2", "/r/admin"), commit("t1", "/r/trafficsim")], cities, line);
    assert.equal(p.get("a2"), 20);
    assert.ok(Math.abs(p.get("a1")! - (20 - slot)) < 1e-9);
    assert.equal(p.get("t1"), 72);
  });
  it("a repo not on the map: to the belt's far end", () => {
    const p = beltPlaces([commit("x", "/elsewhere"), commit("n", null)], cities, line);
    const end = line.belt.x1 - (PKG * line.wu) / 2;
    assert.equal(p.get("n"), end);
    assert.ok(Math.abs(p.get("x")! - (end - slot)) < 1e-9);
  });
  it("twenty packages: never two closer than a slot, all on the belt", () => {
    const many = Array.from({ length: 20 }, (_, i) => commit(`c${String(i).padStart(2, "0")}`, i % 3 ? "/r/admin" : "/r/trafficsim"));
    const xs = [...beltPlaces(many, cities, line).values()].sort((a, b) => a - b);
    assert.equal(xs.length, 20);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= Math.min(slot, (line.belt.x1 - line.belt.x0 - PKG * line.wu) / 19) - 1e-9);
    assert.ok(xs[0] >= line.belt.x0 && xs[19] <= line.belt.x1);
  });
});
