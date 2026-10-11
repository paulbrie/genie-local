import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { deskParts, deskRow, ROW_H, rowRoom } from "./desks";

describe("the Ops view's desks (T198)", () => {
  it("one seat per agent, on one line across (equal depth), in their order, inside the box", () => {
    const r = deskRow(6, 1200, 500);
    assert.equal(r.seats.length, 6);
    assert.ok(r.seats.every((s) => s.y === r.seats[0].y));
    for (let i = 1; i < 6; i++) assert.ok(r.seats[i].x > r.seats[i - 1].x);
    assert.ok(r.seats[0].x > 0 && r.seats[5].x < 1200);
    assert.equal(r.u, 1);
  });
  it("a crowded row shrinks its desks (never below 0.55), and two desks never overlap", () => {
    const r = deskRow(16, 700, 500);
    assert.ok(r.u < 1 && r.u >= 0.55);
    // (a desk spans about 60 px at full size, seat and figure included)
    for (let i = 1; i < 16; i++) assert.ok(r.seats[i].x - r.seats[i - 1].x >= 60 * r.u, `desks ${i - 1} and ${i}`);
  });
  it("a short row stays together in the middle, not spread over the width", () => {
    const r = deskRow(2, 1600, 500);
    assert.ok(r.seats[1].x - r.seats[0].x <= (92 + 14) * 1.5 + 1e-9);
    assert.ok(Math.abs((r.seats[0].x + r.seats[1].x) / 2 + 18 - 800) < 1e-9);
  });
  it("the row sits under the map, within the room it takes; no agents, no desks", () => {
    const r = deskRow(4, 900, 600);
    assert.ok(r.seats[0].y > 600 - rowRoom(r.u) && r.seats[0].y < 600);
    assert.ok(ROW_H * r.u + 22 === rowRoom(r.u));
    assert.deepEqual(deskRow(0, 900, 600).seats, []);
  });
  it("the computer stands on the desk in front of the seat (towards the map, up the screen), the beam leaving its top", () => {
    const d = deskParts(1);
    const deskTop = Math.min(...d.top.top.map((p) => p.y)), monitorTop = Math.min(...d.monitor.top.map((p) => p.y));
    assert.ok(deskTop < 0 && monitorTop < deskTop, "monitor over the desk, over the seat");
    const ys = d.monitor.top.map((p) => p.y);
    assert.ok(d.beam.y >= Math.min(...ys) && d.beam.y <= Math.max(...ys), "the beam leaves the monitor's top");
    assert.ok(Math.max(...d.top.top.map((p) => p.x)) > 0, "the desk to the upper right of its seat");
  });
});
