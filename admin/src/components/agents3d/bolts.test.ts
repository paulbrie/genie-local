import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import * as THREE from "three";

import { BoltPool, tailFade } from "./bolts";

const v = (x: number) => new THREE.Vector3(x, 0, 0);
const red = new THREE.Color("#f00");
/** The pool's bolt cores that show, by their end x (a bolt's last point). */
function shown(pool: BoltPool) {
  return pool.objects
    .filter((o) => o.visible && o.renderOrder === 10 && o instanceof THREE.Mesh && o.geometry.attributes.instanceStart?.data.array.length === 32 * 6)
    .map((o) => ((o as THREE.Mesh).geometry.attributes.instanceEnd.getX(31) as number) | 0);
}

describe("the shared bolt pool (T94)", () => {
  it("draws active bolts first, newest first; past its size the oldest fading ones are dropped", () => {
    const pool = new BoltPool(2, 1);
    pool.begin();
    pool.add(v(0), v(10), red, 1, "edit", 900, 0.5); // fading
    pool.add(v(0), v(20), red, 1, "edit", 300, 1); // active, older
    pool.add(v(0), v(30), red, 1, "read", 100, 1); // active, newest
    assert.equal(pool.draw(0, true, 0), true);
    assert.deepEqual(shown(pool).sort(), [20, 30]);
  });
  it("nothing queued, nothing sparking: hidden, and no frames asked for", () => {
    const pool = new BoltPool(4, 1);
    pool.begin();
    assert.equal(pool.draw(0, true, 0), false);
    assert.deepEqual(shown(pool), []);
  });
  it("a spark burst fires once per key and keeps asking for frames while it falls", () => {
    const pool = new BoltPool(1, 0.3);
    pool.begin();
    pool.burst("Tom|a.ts|1", v(0), red, 1000);
    pool.burst("Tom|a.ts|1", v(0), red, 1200);
    assert.equal(pool.draw(1500, false, 0), true);
    pool.begin();
    assert.equal(pool.draw(1000 + 2000, false, 0), false);
  });
  it("a bolt too faint to see isn't queued", () => {
    const pool = new BoltPool(2, 1);
    pool.begin();
    pool.add(v(0), v(10), red, 1, "edit", 100, 0);
    assert.equal(pool.draw(0, true, 0), false);
  });
  it("tailFade: full while active, a held start of the linger, then out", () => {
    assert.equal(tailFade(500, 1000, 1000), 1);
    assert.equal(tailFade(1300, 1000, 1000), 1);
    assert.ok(tailFade(1700, 1000, 1000) < 1 && tailFade(1700, 1000, 1000) > 0);
    assert.equal(tailFade(2000, 1000, 1000), 0);
    assert.equal(tailFade(1001, 1000, 0), 0);
  });
});
