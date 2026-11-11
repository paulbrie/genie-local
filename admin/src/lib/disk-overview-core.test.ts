import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseDf, parseDuTop } from "./disk-overview-core";

describe("parseDf", () => {
  it("reads each filesystem once, two folders on one disk being one", () => {
    const out = ["Mounted on      1B-blocks         Used        Avail", "/          165295407104 114077167616 51201462272", "/          165295407104 114077167616 51201462272", "/mnt/data 1000 400 600", ""].join("\n");
    assert.deepEqual(parseDf(out), [
      { mount: "/", size: 165295407104, used: 114077167616, avail: 51201462272 },
      { mount: "/mnt/data", size: 1000, used: 400, avail: 600 },
    ]);
  });
});

describe("parseDuTop", () => {
  const out = ["104857600\t/tmp/mecha-assets", "1503238553\t/tmp/tab", "4096\t/tmp/x.log", "692060160\t/tmp/node-compile-cache", "2899102924\t/tmp", ""].join("\n");
  it("is the folder's total and its largest entries, biggest first", () => {
    assert.deepEqual(parseDuTop(out, "/tmp", 2), {
      path: "/tmp",
      bytes: 2899102924,
      top: [
        { name: "tab", bytes: 1503238553 },
        { name: "node-compile-cache", bytes: 692060160 },
      ],
    });
  });
  it("takes the folder with a trailing slash, and is null when du said nothing of it", () => {
    assert.equal(parseDuTop(out, "/tmp/")?.top.length, 4);
    assert.equal(parseDuTop("", "/tmp"), null);
    assert.equal(parseDuTop("12\t/tmpfoo", "/tmp"), null);
  });
});
