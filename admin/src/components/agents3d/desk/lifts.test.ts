import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { Timeline, TLAgent } from "@/lib/agents3d-timeline";
import { LIFT_SETTLE_MS, LIFT_STOREYS, TOUCH_HOLD_MS } from "@/lib/lift";

import { liftsAt, STOREY } from "./lifts";

const T = 1_000_000;
const index = new Map([
  ["admin\nsrc/a.ts", 0],
  ["admin\nsrc/b.ts", 1],
]);
const ev = (ago: number, tool: string, path = "src/a.ts") => ({ ms: T - ago, tool, repo: "admin", path }) as TLAgent["events"][number];
const agent = (...events: TLAgent["events"]) => ({ events: [...events].sort((x, y) => x.ms - y.ms) });
const run = (cast: { events: TLAgent["events"] }[], edits: Timeline["edits"] = [], linger = 0, reduced = false) => {
  const out = new Float32Array(2);
  const lifting = liftsAt(out, index, cast, edits, T, (ms) => T - ms, linger, reduced);
  return { out: [...out], lifting };
};

describe("the Table's touched buildings lift (T108)", () => {
  it("an edit lifts 1.5 storeys, a read 1, once risen", () => {
    assert.deepEqual(run([agent(ev(1000, "Edit"), ev(1000, "Read", "src/b.ts"))]).out, [LIFT_STOREYS.edit * STOREY, LIFT_STOREYS.read * STOREY].map(Math.fround));
  });
  it("several touches of one file: the highest lift, so a new touch keeps it up", () => {
    // An old edit still held, and a read just now (still rising): the edit's height wins.
    const { out } = run([agent(ev(4000, "Edit"), ev(50, "Read"))]);
    assert.equal(out[0], Math.fround(LIFT_STOREYS.edit * STOREY));
  });
  it("settles to 0 after the hold, the linger and the settle; nothing asks for frames then", () => {
    const gone = run([agent(ev(TOUCH_HOLD_MS + 500 + LIFT_SETTLE_MS + 1, "Edit"))], [], 500);
    assert.deepEqual(gone.out, [0, 0]);
    assert.equal(gone.lifting, false);
    const settling = run([agent(ev(TOUCH_HOLD_MS + 500 + LIFT_SETTLE_MS / 2, "Edit"))], [], 500);
    assert.ok(settling.out[0] > 0 && settling.out[0] < LIFT_STOREYS.edit * STOREY);
    assert.equal(settling.lifting, true);
  });
  it("edits seen through file mtimes lift too; other tools and unknown files don't", () => {
    assert.ok(run([], [{ ms: T - 1000, fileKey: "admin\nsrc/b.ts" } as Timeline["edits"][number]]).out[1] > 0);
    assert.deepEqual(run([agent(ev(1000, "Bash"), ev(1000, "Edit", "src/nowhere.ts"))]).out, [0, 0]);
  });
  it("reduced motion: full height at once, no easing", () => {
    assert.equal(run([agent(ev(10, "Edit"))], [], 0, true).out[0], Math.fround(LIFT_STOREYS.edit * STOREY));
    assert.ok(run([agent(ev(10, "Edit"))]).out[0] < LIFT_STOREYS.edit * STOREY);
  });
  it("a touch in the future (replay before it) doesn't lift", () => {
    assert.deepEqual(run([{ events: [{ ms: T + 500, tool: "Edit", repo: "admin", path: "src/a.ts" } as TLAgent["events"][number]] }]).out, [0, 0]);
  });
});
