import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { CityBounds } from "@/lib/city-layout";

import { beltPlaces, PKG, SLOT } from "./belt";
import { deskLine, deskParts, deskSpots, SEAT_MAX } from "./desks";
import type { OpsCommit } from "./model";

// (two cities along x, as the layout lays them)
const cities: CityBounds[] = [
  { repo: "/r/admin", name: "admin", x: 0, z: 0, w: 40, d: 30 },
  { repo: "/r/trafficsim", name: "trafficsim", x: 44, z: 10, w: 56, d: 30 },
];
const commit = (hash: string, repo: string | null, by = "Tom", ms = 0): OpsCommit => ({ hash, label: hash, subject: hash, repo, by, ms, pushed: false });

describe("the Ops view's desks, each in front of its city (T204c)", () => {
  const l = deskLine(cities, 6);
  const team = [
    { key: "Tom", city: "/r/admin" }, { key: "Bob", city: "/r/trafficsim" }, { key: "Ann", city: "/r/admin" },
    { key: "Max", city: null }, { key: "Eve", city: "/elsewhere" },
  ];
  it("an agent sits in front of its city, several side by side along its front, centred on its middle", () => {
    const d = deskSpots(cities, team, l.wu, 0);
    const tom = d.seats.get("Tom")!, ann = d.seats.get("Ann")!, bob = d.seats.get("Bob")!;
    assert.equal(tom.z, ann.z);
    assert.ok(Math.abs((tom.x + ann.x) / 2 - 20) < 1e-9 && ann.x - tom.x >= 4.4 * l.wu, "side by side, centred on admin's middle (x 20), clear of each other");
    assert.ok(Math.abs(bob.x - 72) < 1e-9, "Bob at trafficsim's middle");
    assert.ok(tom.z > 30 && bob.z > 40, "each in front of its city's front edge");
  });
  it("no city, or one not on the map: the lounge, left of the leftmost city", () => {
    const d = deskSpots(cities, team, l.wu, 0);
    assert.ok(d.seats.get("Max")!.x < 0 && d.seats.get("Eve")!.x < 0 && d.seats.get("Max")!.x !== d.seats.get("Eve")!.x);
  });
  it("far enough out that a head and its bubble (`lift` over the seat) stay clear of the city on screen", () => {
    const lift = 12, d = deskSpots(cities, team, l.wu, lift), bob = d.seats.get("Bob")!;
    // (a point `lift` over the seat shows where the ground twice as far back would: still in front of the city)
    assert.ok(bob.z - 2 * lift >= 40 - 1e-9);
    assert.ok(d.extent.length >= 8, "every city's desk band in the fit, and the lounge's");
  });
  it("the manager (T204e): no city, a row of its own in front of every desk, centred on the cities", () => {
    const d = deskSpots(cities, [...team, { key: "Alice", city: "/r/admin", manager: true }], l.wu, 6);
    const boss = d.seats.get("Alice")!, others = team.map((t) => d.seats.get(t.key)!);
    assert.ok(Math.abs(boss.x - 50) < 1e-9);
    assert.ok(others.every((o) => boss.z >= o.z + 10 * l.wu - 1e-9), "in front of all the others by its row's gap");
    assert.ok(d.seats.get("Tom")!.x === deskSpots(cities, team, l.wu, 6).seats.get("Tom")!.x, "the agents' seats as without it");
  });
  it("a desk at the files' scale, however long the cities", () => {
    assert.ok(7 * l.wu <= SEAT_MAX + 1e-9);
  });
  it("a belt per city (T204): along its far side, its length, a gap behind it (from the viewer: desks, cities, belts)", () => {
    assert.deepEqual(l.belts.map((b) => b.repo), ["/r/admin", "/r/trafficsim"]);
    l.belts.forEach((b, i) => {
      const c = cities[i];
      assert.deepEqual([b.x0, b.x1], [c.x, c.x + c.w]);
      assert.ok(b.z1 < c.z - 2 * l.wu && b.z0 < b.z1, "behind its city's far edge, with a gap");
    });
    assert.equal(l.extent.length, 2 * 2);
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
  it("the cafeteria (T210): a table near the front, in front of every desk; away agents round it facing it, the first on its far side; their desks kept", () => {
    const team = [{ key: "Tom", city: "/r/admin" }, { key: "Bob", city: "/r/trafficsim" }, { key: "Max", city: null }, { key: "Eve", city: "/elsewhere" }];
    const d = deskSpots(cities, [...team.map((t) => ({ ...t, away: t.key === "Tom" || t.key === "Bob" })), { key: "Alice", city: null, manager: true, away: true }], line.wu, 0);
    assert.ok(team.every((t) => d.cafe.z - d.cafe.r - 2.5 * line.wu > d.seats.get(t.key)!.z), "in front of every agent's desk, chairs and all");
    assert.ok(Math.abs(d.cafe.x - d.seats.get("Alice")!.x) > d.cafe.r + 7 * line.wu, "clear of the manager's desk");
    assert.deepEqual([...d.cafeSeats.keys()], ["Tom", "Bob"], "the manager stays at its desk");
    for (const s of d.cafeSeats.values()) {
      const toTable = { x: d.cafe.x - s.x, z: d.cafe.z - s.z }, fwd = { x: -Math.sin(s.yaw), z: -Math.cos(s.yaw) };
      assert.ok((toTable.x * fwd.x + toTable.z * fwd.z) / Math.hypot(toTable.x, toTable.z) > 0.999, "facing the table");
    }
    assert.ok(Math.min(...[...d.cafeSeats.values()].map((s) => s.z)) < d.cafe.z, "on the far side, faces to the viewer");
    assert.ok(d.seats.has("Tom") && d.seats.has("Bob"), "their desks stay");
  });
});
