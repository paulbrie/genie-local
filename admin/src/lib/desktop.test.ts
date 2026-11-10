import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appOf,
  clampRect,
  DEFAULT_PINNED,
  defaultGeom,
  DOCK_SPACE,
  maxRect,
  MIN_WIN,
  parseDesk,
  parseShellMode,
  resizeRect,
  subPath,
  unmaximizeUnder,
  iconGridSize,
  layoutIcons,
  moveIcon,
  sortedIcons,
} from "./desktop";

const APPS = ["/", "/projects", "/terminals", "/boards", "/files", "/claude", "/tasks", "/teams", "/agents", "/agents3d"];

describe("parseShellMode", () => {
  it("is desktop only when the cookie says so", () => {
    assert.equal(parseShellMode("desktop"), "desktop");
    for (const v of ["classic", "", "Desktop", undefined, null]) assert.equal(parseShellMode(v), "classic", String(v));
  });
});

describe("appOf", () => {
  it("finds the app a path is, or sits under", () => {
    assert.equal(appOf("/", APPS), "/");
    assert.equal(appOf("/projects", APPS), "/projects");
    assert.equal(appOf("/projects/shop/git", APPS), "/projects");
    assert.equal(appOf("/boards/12", APPS), "/boards");
    assert.equal(appOf("/teams/abc", APPS), "/teams");
  });
  it("takes the longest match, and never a mere prefix of a name", () => {
    assert.equal(appOf("/agents3d", APPS), "/agents3d");
    assert.equal(appOf("/agents/run", APPS), "/agents");
    assert.equal(appOf("/filesystem", APPS), null);
  });
  it("is null for a path outside every app (the dashboard is only /)", () => {
    assert.equal(appOf("/login", APPS), null);
    assert.equal(appOf("/nowhere/x", APPS), null);
  });
});

describe("subPath", () => {
  it("is what follows the app, decoded", () => {
    assert.deepEqual(subPath("/projects/my%20shop/git", "/projects"), ["my shop", "git"]);
    assert.deepEqual(subPath("/projects", "/projects"), []);
    assert.deepEqual(subPath("/", "/"), []);
  });
  it("is the whole path when no app owns it, and survives bad escapes", () => {
    assert.deepEqual(subPath("/x/y", null), ["x", "y"]);
    assert.deepEqual(subPath("/boards/%E0%A4%A", "/boards"), ["%E0%A4%A"]);
  });
});

describe("window geometry", () => {
  it("a first window leaves two icon columns on a wide screen and the dock below", () => {
    const g = defaultGeom(1600, 900);
    assert.equal(g.x, 204);
    assert.equal(g.x + g.w, 1600 - 16);
    assert.equal(g.y + g.h, 900 - DOCK_SPACE);
  });
  it("a first window on a narrow screen fills the width", () => {
    const g = defaultGeom(1000, 700);
    assert.ok(g.x <= 24);
    assert.ok(g.x + g.w <= 1000);
  });
  it("maximized fills the workspace above the dock", () => {
    assert.deepEqual(maxRect(1200, 800), { x: 8, y: 8, w: 1184, h: 800 - 8 - DOCK_SPACE });
  });
  it("clamps size to the workspace and the minimum", () => {
    assert.deepEqual(clampRect({ x: 0, y: 0, w: 5000, h: 5000 }, 1200, 800), { x: 0, y: 0, w: 1200, h: 800 });
    const small = clampRect({ x: 10, y: 10, w: 50, h: 50 }, 1200, 800);
    assert.equal(small.w, MIN_WIN.w);
    assert.equal(small.h, MIN_WIN.h);
  });
  it("keeps the title bar reachable", () => {
    const off = clampRect({ x: -2000, y: -50, w: 800, h: 500 }, 1200, 800);
    assert.equal(off.y, 0);
    assert.ok(off.x + off.w >= 96, "some of the bar shows on the left");
    const right = clampRect({ x: 5000, y: 5000, w: 800, h: 500 }, 1200, 800);
    assert.ok(right.x <= 1200 - 96);
    assert.ok(right.y <= 800 - 36);
  });
  it("a workspace smaller than the minimum gets a window its size", () => {
    assert.deepEqual(clampRect({ x: 0, y: 0, w: 900, h: 900 }, 300, 200), { x: 0, y: 0, w: 300, h: 200 });
  });
});

describe("resizeRect", () => {
  const start = { x: 100, y: 100, w: 600, h: 400 };
  it("right / bottom grow and shrink, down to the minimum and up to the workspace", () => {
    assert.deepEqual(resizeRect(start, { r: true, b: true }, 50, 30, 1200, 800), { x: 100, y: 100, w: 650, h: 430 });
    assert.deepEqual(resizeRect(start, { r: true, b: true }, -1000, -1000, 1200, 800), { x: 100, y: 100, ...MIN_WIN });
    assert.deepEqual(resizeRect(start, { r: true }, 5000, 0, 1200, 800), { x: 100, y: 100, w: 1100, h: 400 });
  });
  it("left / top move the origin and keep the opposite edge where it was", () => {
    const r = resizeRect(start, { l: true, t: true }, -40, -20, 1200, 800);
    assert.deepEqual(r, { x: 60, y: 80, w: 640, h: 420 });
    const tight = resizeRect(start, { l: true }, 1000, 0, 1200, 800);
    assert.equal(tight.w, MIN_WIN.w);
    assert.equal(tight.x + tight.w, start.x + start.w);
    const past = resizeRect(start, { t: true }, 0, -500, 1200, 800);
    assert.equal(past.y, 0);
    assert.equal(past.y + past.h, start.y + start.h);
  });
});

describe("unmaximizeUnder", () => {
  it("keeps the grabbed point at the same fraction of the bar", () => {
    const max = { x: 8, y: 8, w: 1000, h: 700 };
    const r = unmaximizeUnder({ x: 300, y: 200, w: 500, h: 400 }, max, 758);
    assert.equal(r.w, 500);
    assert.equal(r.x, 758 - 0.75 * 500);
    assert.equal(r.y, 8);
  });
});

describe("parseDesk", () => {
  it("gives the defaults for nothing stored or anything unreadable", () => {
    for (const raw of [null, "", "nope", "[]", "42"])
      assert.deepEqual(parseDesk(raw, APPS), { pinned: DEFAULT_PINNED.filter((a) => APPS.includes(a)), geoms: {} });
  });
  it("keeps known apps only, once each, and valid geometry only", () => {
    const raw = JSON.stringify({
      pinned: ["/files", "/gone", "/files", 7, "/"],
      geoms: {
        "/files": { x: 1, y: 2, w: 300, h: 200, max: true },
        "/": { x: 1, y: 2, w: 0, h: 200 },
        "/terminals": { x: "1", y: 2, w: 300, h: 200 },
        "/gone": { x: 1, y: 2, w: 300, h: 200 },
        "/boards": { x: 0, y: 0, w: 500, h: 300, max: "yes" },
      },
    });
    assert.deepEqual(parseDesk(raw, APPS), {
      pinned: ["/files", "/"],
      geoms: { "/files": { x: 1, y: 2, w: 300, h: 200, max: true }, "/boards": { x: 0, y: 0, w: 500, h: 300 } },
    });
  });
  it("an emptied dock stays empty", () => {
    assert.deepEqual(parseDesk(JSON.stringify({ pinned: [] }), APPS).pinned, []);
  });
});

describe("desktop icons", () => {
  const ids = ["a", "b", "c", "d", "e"];
  it("lays them down the first column, then the next, by default", () => {
    assert.deepEqual(layoutIcons(ids, undefined, 4, 2), { a: { c: 0, r: 0 }, b: { c: 0, r: 1 }, c: { c: 1, r: 0 }, d: { c: 1, r: 1 }, e: { c: 2, r: 0 } });
  });
  it("keeps saved spots, and fills around them", () => {
    const l = layoutIcons(ids, { e: { c: 0, r: 0 }, c: { c: 3, r: 1 } }, 4, 2);
    assert.deepEqual(l.e, { c: 0, r: 0 });
    assert.deepEqual(l.c, { c: 3, r: 1 });
    assert.deepEqual(l.a, { c: 0, r: 1 });
    assert.deepEqual(l.b, { c: 1, r: 0 });
    assert.equal(new Set(Object.values(l).map((c) => `${c.c},${c.r}`)).size, ids.length);
  });
  it("moves a saved spot that no longer fits to the nearest free one", () => {
    const l = layoutIcons(["a", "b"], { a: { c: 9, r: 9 } }, 3, 2);
    assert.deepEqual(l.a, { c: 2, r: 1 });
    assert.deepEqual(l.b, { c: 0, r: 0 });
  });
  it("gives two icons saved on one spot one each", () => {
    const l = layoutIcons(["a", "b"], { a: { c: 1, r: 0 }, b: { c: 1, r: 0 } }, 3, 2);
    assert.deepEqual(l.a, { c: 1, r: 0 });
    assert.notDeepEqual(l.b, { c: 1, r: 0 });
  });
  it("swaps with the icon dropped on, moves into a free spot", () => {
    const l = layoutIcons(ids, undefined, 4, 2);
    const swapped = moveIcon(l, "a", { c: 1, r: 1 });
    assert.deepEqual(swapped.a, { c: 1, r: 1 });
    assert.deepEqual(swapped.d, { c: 0, r: 0 });
    const free = moveIcon(l, "a", { c: 3, r: 1 });
    assert.deepEqual(free.a, { c: 3, r: 1 });
    assert.equal(Object.values(free).filter((c) => c.c === 0 && c.r === 0).length, 0);
    assert.equal(moveIcon(l, "a", { c: 0, r: 0 }), l);
  });
  it("sorts by name", () => {
    const l = sortedIcons(["/z", "/a", "/m"], (id) => ({ "/z": "Zed", "/a": "Apple", "/m": "Mango" })[id]!, 2);
    assert.deepEqual(l, { "/a": { c: 0, r: 0 }, "/m": { c: 0, r: 1 }, "/z": { c: 1, r: 0 } });
  });
  it("reads saved spots back, dropping what it doesn't know", () => {
    const d = parseDesk(JSON.stringify({ pinned: [], icons: { "/": { c: 2, r: 1 }, vscode: { c: 0, r: 3 }, "/gone": { c: 1, r: 1 }, "/projects": { c: -1, r: 0 } } }), ["/", "/projects"]);
    assert.deepEqual(d.icons, { "/": { c: 2, r: 1 }, vscode: { c: 0, r: 3 } });
  });
  it("fits as many columns and rows as the desktop has room for", () => {
    assert.deepEqual(iconGridSize(1440, 860), { cols: 15, rows: 7 });
  });
});
