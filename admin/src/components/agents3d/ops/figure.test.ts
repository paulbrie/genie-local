import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { boneFaces, facing, figureBones, figureFaces, forward, type Doing } from "./figure";

const POSES: Doing[] = ["type", "read", "run", "think", "wait", "idle", "nap"];
const bone = (d: Doing, name: string) => figureBones(d).find((b) => b.name === name)!;
const DESK = { top: 2.6, near: -1.4, far: -3.6 };

describe("the seated agent in isometric boxes (T202)", () => {
  it("every pose has a head, neck, torso, pelvis, and each side's upper arm, forearm, hand, thigh, shin and foot", () => {
    for (const d of POSES) {
      const names = figureBones(d).map((b) => b.name).sort();
      assert.deepEqual(names, ["fore-l", "fore-r", "foot-l", "foot-r", "hand-l", "hand-r", "head", "neck", "pelvis", "shin-l", "shin-r", "thigh-l", "thigh-r", "torso", "upper-l", "upper-r"].sort(), d);
    }
  });
  it("seated: the feet on the ground, the hips on the stool, the limbs joined (a bone starts where the one before ends)", () => {
    for (const d of POSES) {
      for (const s of ["l", "r"]) {
        assert.ok(Math.abs(bone(d, `foot-${s}`).a.h - 0.12) < 1e-9, `${d} foot on the ground`);
        assert.deepEqual(bone(d, `upper-${s}`).b, bone(d, `fore-${s}`).a, `${d} elbow`);
        assert.deepEqual(bone(d, `fore-${s}`).b, bone(d, `hand-${s}`).a, `${d} wrist`);
        assert.deepEqual(bone(d, `thigh-${s}`).b, bone(d, `shin-${s}`).a, `${d} knee`);
      }
      assert.ok(Math.abs(bone(d, "torso").a.h - 1.55) < 1e-9, `${d} hips on the stool`);
    }
  });
  it("typing: both hands on the keys (on the desk, at its near edge)", () => {
    for (const s of ["l", "r"]) {
      const h = bone("type", `hand-${s}`).a;
      assert.ok(h.h > DESK.top && h.h < DESK.top + 0.2 && h.z < DESK.near && h.z > DESK.far);
    }
  });
  it("reading: leaning in, a hand on the mouse to the right; thinking: a hand at the chin", () => {
    assert.ok(bone("read", "torso").b.z < bone("type", "torso").b.z);
    assert.ok(bone("read", "hand-r").a.x > 1 && bone("read", "hand-r").a.h < DESK.top + 0.2);
    const chin = bone("think", "head").a, hand = bone("think", "hand-r").b;
    assert.ok(Math.hypot(hand.x - chin.x, hand.h - chin.h, hand.z - chin.z) < 0.9);
  });
  it("waiting: turned to the viewer (+z), the right hand raised over the head; idle: leaning back; napping: the head down on the desk", () => {
    assert.equal(facing("wait"), 1);
    assert.ok(POSES.filter((d) => d !== "wait").every((d) => facing(d) === -1));
    assert.ok(bone("wait", "hand-r").b.h > bone("wait", "head").b.h);
    assert.ok(bone("idle", "torso").b.z > bone("idle", "torso").a.z);
    const h = bone("nap", "head");
    assert.ok(h.a.z < DESK.near && Math.min(h.a.h, h.b.h) > DESK.top - 0.1 && h.b.h < 4.5);
  });
  it("a box shows at most three faces, those towards the viewer; the pose's faces come back to front", () => {
    for (const d of POSES) {
      for (const b of figureBones(d)) {
        const f = boneFaces(b);
        assert.ok(f.length >= 1 && f.length <= 3, `${d} ${b.name}: ${f.length}`);
      }
      const all = figureFaces(d);
      for (let i = 1; i < all.length; i++) assert.ok(all[i].depth >= all[i - 1].depth);
    }
  });
  it("the cafeteria's poses (T210): a cup in the right hand, at the mouth when sipping; turned by yaw, the same figure", () => {
    const cup = (d: Doing) => figureBones(d).find((b) => b.name === "cup")!;
    assert.ok(cup("cafe") && cup("sip"));
    assert.ok(cup("sip").a.h > bone("sip", "head").a.h - 0.4, "lifted to the mouth");
    assert.ok(!figureBones("type").some((b) => b.name === "cup"));
    const a = figureBones("cafe", Math.PI), b = figureBones("cafe");
    a.forEach((x, i) => { assert.ok(Math.abs(x.a.x + b[i].a.x) < 1e-9 && Math.abs(x.a.z + b[i].a.z) < 1e-9 && x.a.h === b[i].a.h, x.name); });
    assert.deepEqual([Math.round(forward("cafe", Math.PI).z), Math.round(forward("cafe").z)], [1, -1]);
  });
});
