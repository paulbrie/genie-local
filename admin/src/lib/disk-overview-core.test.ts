import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { otherPart, parseDf, parseDockerDf, parseDockerSize, parseDuTop, parseDuTree } from "./disk-overview-core";

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

describe("Docker's part", () => {
  it("reads docker's decimal sizes", () => {
    assert.equal(parseDockerSize("8.033GB"), 8_033_000_000);
    assert.equal(parseDockerSize("9.884MB"), 9_884_000);
    assert.equal(parseDockerSize("0B"), 0);
    assert.equal(parseDockerSize("nonsense"), 0);
  });
  it("is the kinds docker counts, the biggest first, empty ones left out", () => {
    const out = ["Images\t8.033GB", "Containers\t9.884MB", "Local Volumes\t1.06GB", "Build Cache\t0B", ""].join("\n");
    assert.deepEqual(parseDockerDf(out), {
      key: "docker",
      label: "Docker",
      bytes: 8_033_000_000 + 1_060_000_000 + 9_884_000,
      top: [
        { name: "images", bytes: 8_033_000_000 },
        { name: "local volumes", bytes: 1_060_000_000 },
        { name: "containers", bytes: 9_884_000 },
      ],
    });
    assert.equal(parseDockerDf(""), null);
  });
});

describe("otherPart", () => {
  it("is what's used that nothing measured accounts for, never below 0", () => {
    const parts = [
      { key: "/a", label: "/a", bytes: 60, top: [] },
      { key: "docker", label: "Docker", bytes: 25, top: [] },
    ];
    assert.equal(otherPart(100, parts).bytes, 15);
    assert.equal(otherPart(50, parts).bytes, 0);
  });
});

describe("parseDuTree", () => {
  it("is the folder's entries, the biggest first, each with its own biggest", () => {
    const out = [
      "300\t/opt/p/projects/shop/node_modules",
      "100\t/opt/p/projects/shop/src",
      "450\t/opt/p/projects/shop",
      "80\t/opt/p/projects/blog/src",
      "90\t/opt/p/projects/blog",
      "40\t/opt/p/projects/notes.md",
      "580\t/opt/p/projects",
      "",
    ].join("\n");
    assert.deepEqual(parseDuTree(out, "/opt/p/projects/", 2, 1), {
      path: "/opt/p/projects",
      bytes: 580,
      entries: [
        { name: "shop", bytes: 450, dir: true, top: [{ name: "node_modules", bytes: 300 }] },
        { name: "blog", bytes: 90, dir: true, top: [{ name: "src", bytes: 80 }] },
      ],
    });
    assert.equal(parseDuTree(out, "/opt/p/projects")?.entries.find((e) => e.name === "notes.md")?.dir, undefined);
    assert.equal(parseDuTree("", "/x"), null);
  });
});
