import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { CityLayout } from "@/lib/city-layout";

import {
  AVATAR_SCALE,
  BOARD,
  BODY,
  CHAIR_R,
  CITY_SCALE,
  DISTRICT_LABEL_DIST,
  districtSpots,
  FLOOR_Y,
  laptopAt,
  miniCities,
  nearestSpots,
  packCities,
  PERSON_H,
  SEAT_Y,
  SEATED_LEG,
  seatAt,
  SHELF_SPOT,
  TABLE,
  WALK,
} from "./world";

/** Cities as the layout makes them: squares in one row along x, GAP 8 apart, centred on z. */
function row(sides: number[]) {
  let x = 0;
  return sides.map((w, i) => {
    const c = { repo: `r${i}`, name: `r${i}`, x, z: -w / 2, w, d: w };
    x += w + 8;
    return c;
  });
}

const layoutOf = (sides: number[], districts: CityLayout["districts"] = []): CityLayout => ({
  buildings: [],
  index: new Map(),
  districts,
  cities: row(sides),
  size: 1,
});

describe("packCities", () => {
  const R = 10;
  for (const sides of [[37], [37, 42], [37, 42, 57], [37, 42, 57, 14, 39, 15], [5, 5, 5, 5, 5, 5, 5, 5, 5, 5]]) {
    it(`${sides.length} cities: inside the radius, no overlaps`, () => {
      const cities = row(sides);
      const { s, shift } = packCities(cities, R);
      const boxes = cities.map((c) => {
        const d = shift.get(c.repo)!;
        return { x: (c.x + c.w / 2 + d.dx) * s, z: (c.z + c.d / 2 + d.dz) * s, w: c.w * s, d: c.d * s };
      });
      for (const b of boxes) assert.ok(Math.hypot(Math.abs(b.x) + b.w / 2, Math.abs(b.z) + b.d / 2) <= R + 1e-6);
      for (const a of boxes)
        for (const b of boxes) if (a !== b) assert.ok(Math.abs(a.x - b.x) >= (a.w + b.w) / 2 - 1e-6 || Math.abs(a.z - b.z) >= (a.d + b.d) / 2 - 1e-6);
    });
  }
  it("rows make several cities bigger than one long row", () => {
    const cities = row([37, 42, 57]);
    const span = 37 + 42 + 57 + 16;
    const oneRow = (2 * R) / Math.hypot(span, 57);
    assert.ok(packCities(cities, R).s > oneRow * 1.3);
  });
  it("a lone small city stops at the cap", () => {
    assert.equal(packCities(row([4]), R, 3, 0.35).s, 0.35);
  });
  it("is deterministic", () => {
    const a = packCities(row([20, 20, 30, 10]), R);
    const b = packCities(row([20, 20, 30, 10]), R);
    assert.deepEqual([...a.shift], [...b.shift]);
  });
});

describe("neighbourhood names", () => {
  const d = (dir: string, depth: number, w: number) => ({ repo: "r0", dir, depth, x: 0, z: -20, w, d: w });
  const layout = layoutOf([40], [d("src", 0, 30), d("src/lib", 1, 20), d("tiny", 0, 1)]);
  const mini = miniCities(layout);
  const spots = districtSpots(layout, mini);

  it("deeper folders need a closer camera; folders too small get none", () => {
    assert.ok(mini.s * 40 <= 2 * CITY_SCALE * TABLE.r);
    assert.equal(spots.names.join(","), "src,lib,tiny");
    assert.equal(spots.near2[0], DISTRICT_LABEL_DIST ** 2);
    assert.ok(spots.near2[1] > 0 && spots.near2[1] < spots.near2[0]);
    assert.equal(spots.near2[2], 0);
  });
  it("nearestSpots: within distance only, nearest first, capped", () => {
    const sp = {
      x: Float32Array.from([0, 1, 2, 3, 50]),
      y: new Float32Array(5),
      z: new Float32Array(5),
      near2: Float32Array.from([100, 100, 100, 100, 100]),
    };
    const idx = new Int32Array(3);
    const d2 = new Float32Array(3);
    assert.equal(nearestSpots(2.9, 0, 0, sp, idx, d2), 3);
    assert.deepEqual([...idx], [3, 2, 1]);
    // From far away: none.
    assert.equal(nearestSpots(0, 40, 0, sp, idx, d2), 0);
  });
});

describe("a table of normal height (T96)", () => {
  const S = AVATAR_SCALE;
  it("a standing person is 2.41 model units × the scale (about 7.9, '1.75 m')", () => {
    assert.ok(Math.abs(PERSON_H - 7.95) < 0.05);
  });
  it("the top at the seated elbow height: about 0.35 of a standing person, the floor below it", () => {
    const ratio = TABLE.h / PERSON_H;
    assert.ok(ratio > 0.33 && ratio < 0.37, `ratio ${ratio}`);
    assert.equal(FLOOR_Y, -TABLE.h);
    const shoulder = SEAT_Y + BODY.shoulder * S;
    const elbow = shoulder - BODY.upperArm * S;
    assert.ok(Math.abs(elbow) < 1e-9, `elbow ${elbow}`);
  });
  it("seated: feet on the floor, head and shoulders above the top", () => {
    const hip = SEAT_Y + BODY.hip * S;
    const sole = hip - BODY.leg * S * Math.cos(SEATED_LEG);
    assert.ok(Math.abs(sole - FLOOR_Y) < 1e-9, `sole ${sole}`);
    assert.ok(SEAT_Y + BODY.shoulder * S > 0.6);
    assert.ok(SEAT_Y + BODY.h * S > 4);
  });
  it("a standing avatar's head stays under the whiteboard, which reads over the seated ones", () => {
    assert.ok(FLOOR_Y + PERSON_H < BOARD.y);
  });
});

describe("room to walk (T96)", () => {
  it("chairs stay inside the walking ring, for any number of people", () => {
    for (const n of [1, 6, 9, 13, 16]) for (let i = 0; i < n; i++) assert.ok(Math.hypot(seatAt(i, n).x, seatAt(i, n).z) + AVATAR_SCALE * 0.7 <= CHAIR_R + 1e-9);
    assert.ok(WALK.r0 > CHAIR_R && WALK.r1 - WALK.r0 >= 3);
  });
  it("the whiteboard (with its gauges) and the bookshelf's spot are past the ring, clear of each other", () => {
    const boardFront = Math.abs(BOARD.z) - 0.6;
    assert.ok(boardFront > WALK.r1, `board ${boardFront} vs ring ${WALK.r1}`);
    const shelfFront = Math.hypot(SHELF_SPOT.x, Math.abs(SHELF_SPOT.z) - SHELF_SPOT.d / 2);
    assert.ok(shelfFront > WALK.r1, `shelf ${shelfFront}`);
    const boardLeft = BOARD.x - BOARD.w / 2 - 0.4;
    assert.ok(SHELF_SPOT.x + SHELF_SPOT.w / 2 < boardLeft, "the shelf is left of the board");
  });
  it("laptops stay on the table", () => {
    for (let i = 0; i < 9; i++) assert.ok(Math.hypot(laptopAt(seatAt(i, 9)).x, laptopAt(seatAt(i, 9)).z) < TABLE.r - 1);
  });
});
