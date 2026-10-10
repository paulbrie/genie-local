import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { escapeAction, type EscapeState } from "./escape";

const calm: EscapeState = { typing: false, handled: false, messageOpen: false, overlay: false, selected: false, following: false };

describe("escapeAction", () => {
  it("resets the camera only when nothing is open", () => {
    assert.equal(escapeAction(calm), "reset-camera");
  });
  it("leaves Escape to an input, an inner layer that used it, or an open message", () => {
    for (const k of ["typing", "handled", "messageOpen"] as const) assert.equal(escapeAction({ ...calm, [k]: true, selected: true, overlay: true }), "none", k);
  });
  it("closes one thing per press: the overlay first, then the selection and follow", () => {
    const all = { ...calm, overlay: true, selected: true, following: true };
    assert.equal(escapeAction(all), "exit-overlay");
    assert.equal(escapeAction({ ...all, overlay: false }), "deselect");
    assert.equal(escapeAction({ ...calm, following: true }), "deselect");
    assert.equal(escapeAction({ ...calm, selected: true }), "deselect");
  });
});
