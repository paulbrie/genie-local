import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cappedFps } from "./frame-governor";

describe("cappedFps (Low power, T162)", () => {
  it("leaves every request as asked when Low power is off", () => {
    assert.equal(cappedFps(60, "event", false), 60);
    assert.equal(cappedFps(30, "ambient", false), 30);
  });
  it("holds events to 30 and ambient motion to 15 when on; slower requests stay as asked", () => {
    assert.equal(cappedFps(60, "event", true), 30);
    assert.equal(cappedFps(30, undefined, true), 30);
    assert.equal(cappedFps(30, "ambient", true), 15);
    assert.equal(cappedFps(4, "ambient", true), 4);
  });
});
