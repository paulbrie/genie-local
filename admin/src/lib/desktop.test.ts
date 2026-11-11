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
  cellsRect,
  defaultWidgetAt,
  deskWidgets,
  moveCells,
  overlaps,
  placeWidgets,
  resizeCells,
  WIDGET_MIN,
  alignShift,
  dockSpace,
  DOCK_ICON,
  dropRange,
  fitShift,
  widgetMode,
  arrangementFits,
  stackDesktop,
  widgetWants,
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
  it("keep off the widgets' cells", () => {
    const l = layoutIcons(["a", "b", "c"], { a: { c: 1, r: 0 } }, 4, 2, [{ c: 0, r: 0, w: 2, h: 1 }]);
    assert.deepEqual(l.a, { c: 1, r: 1 }, "a saved spot under a widget: the nearest free one");
    assert.deepEqual(l.b, { c: 0, r: 1 });
    assert.deepEqual(l.c, { c: 2, r: 0 });
    const sorted = sortedIcons(["/z", "/a", "/m"], (id) => id, 2, [{ c: 0, r: 0, w: 1, h: 1 }]);
    assert.deepEqual(sorted, { "/a": { c: 0, r: 1 }, "/m": { c: 1, r: 0 }, "/z": { c: 1, r: 1 } });
  });
  it("fits as many columns and rows as the desktop has room for", () => {
    assert.deepEqual(iconGridSize(1440, 860), { cols: 15, rows: 7 });
  });
  it("lose a row to a bigger dock, and gain one from a smaller", () => {
    assert.equal(dockSpace(), DOCK_SPACE);
    assert.equal(iconGridSize(1440, 780).rows, 7);
    assert.equal(iconGridSize(1440, 780, dockSpace(DOCK_ICON.max)).rows, 6);
    assert.equal(iconGridSize(1440, 760).rows, 6);
    assert.equal(iconGridSize(1440, 760, dockSpace(DOCK_ICON.min)).rows, 7);
  });
});

describe("desktop widgets", () => {
  it("are three icons by three at the least, on the icons' own grid, inset so two side by side are 16px apart", () => {
    const r = cellsRect({ c: 1, r: 2, ...WIDGET_MIN });
    assert.deepEqual(r, { x: 12 + 92 + 8, y: 12 + 2 * 96 + 8, w: 3 * 92 - 16, h: 3 * 96 - 16 });
    const next = cellsRect({ c: 4, r: 2, ...WIDGET_MIN });
    assert.equal(next.x - (r.x + r.w), 16);
  });
  it("start at the top right, the projects under the terminals, the disk and the memory to their left", () => {
    assert.deepEqual(deskWidgets(undefined, 15, 7), {
      terminals: { c: 12, r: 0, w: 3, h: 3 },
      projects: { c: 12, r: 3, w: 3, h: 4 },
      disk: { c: 9, r: 0, w: 3, h: 4 },
      memory: { c: 6, r: 0, w: 3, h: 4 },
      processes: { c: 9, r: 4, w: 3, h: 3 },
      docker: { c: 6, r: 4, w: 3, h: 3 },
    });
    assert.deepEqual(defaultWidgetAt("terminals", 15), { c: 12, r: 0, w: 3, h: 3 });
  });
  it("a hidden one isn't placed, and a folded one takes its header's row", () => {
    assert.deepEqual(
      deskWidgets({ terminals: { mode: "hidden" }, projects: { mode: "collapsed", at: { c: 2, r: 1, w: 4, h: 5 } }, disk: { mode: "hidden" }, memory: { mode: "hidden" }, processes: { mode: "hidden" }, docker: { mode: "hidden" } }, 15, 7),
      { projects: { c: 2, r: 1, w: 4, h: 1 } },
    );
  });
  it("are kept on a smaller grid, and off each other", () => {
    const p = placeWidgets(
      [
        { id: "a", at: { c: 20, r: 0, w: 3, h: 3 } },
        { id: "b", at: { c: 20, r: 1, w: 3, h: 3 } },
      ],
      10,
      5,
    );
    assert.deepEqual(p.a, { c: 7, r: 0, w: 3, h: 3 });
    assert.ok(!overlaps(p.a, p.b));
    assert.deepEqual(p.b, { c: 4, r: 1, w: 3, h: 3 }, "the nearest spot clear of the first");
    assert.deepEqual(placeWidgets([{ id: "a", at: { c: 0, r: 0, w: 30, h: 9 } }], 10, 5).a, { c: 0, r: 0, w: 10, h: 5 });
  });
  it("move by whole cells, the nearest to the pointer, and stay within the room", () => {
    const a = { c: 2, r: 1, w: 3, h: 3 };
    assert.deepEqual(moveCells(a, 1.4, 0.6, { lo: 0, hi: 12 }, 7), { c: 3, r: 2, w: 3, h: 3 });
    assert.deepEqual(moveCells(a, -9, 9, { lo: 0, hi: 12 }, 7), { c: 0, r: 4, w: 3, h: 3 });
    assert.deepEqual(moveCells(a, -9, 0, { lo: -4, hi: 12 }, 7).c, -4, "left of the grid, where there's room for the lot to move over");
  });
  it("resize from any edge, never under three by three, the other edges staying", () => {
    const a = { c: 4, r: 1, w: 4, h: 4 };
    const room = { lo: 0, hi: 15 };
    assert.deepEqual(resizeCells(a, { r: true, b: true }, 1.6, 0.4, room, 7), { c: 4, r: 1, w: 6, h: 4 });
    assert.deepEqual(resizeCells(a, { r: true, b: true }, -5, -5, room, 7), { c: 4, r: 1, ...WIDGET_MIN });
    assert.deepEqual(resizeCells(a, { l: true, t: true }, 5, 5, room, 7), { c: 5, r: 2, ...WIDGET_MIN });
    assert.deepEqual(resizeCells(a, { l: true }, -9, 0, room, 7), { c: 0, r: 1, w: 8, h: 4 });
    assert.deepEqual(resizeCells(a, { r: true }, 30, 0, room, 7), { c: 4, r: 1, w: 11, h: 4 });
    assert.deepEqual(resizeCells(a, { b: true }, 0, 9, room, 7), { c: 4, r: 1, w: 4, h: 6 });
  });
  it("remember their spot, folded or hidden, and carry over the one status widget's", () => {
    const d = parseDesk(
      JSON.stringify({ widgets: { terminals: { at: { c: 1, r: 2, w: 1, h: 5 }, mode: "collapsed" }, projects: { mode: "sideways", at: { c: -1, r: 0, w: 3, h: 3 } } } }),
      ["/"],
    );
    assert.deepEqual(d.widgets, { terminals: { at: { c: 1, r: 2, w: 3, h: 5 }, mode: "collapsed" } });
    assert.deepEqual(parseDesk(JSON.stringify({ widget: "hidden" }), ["/"]).widgets, {
      terminals: { mode: "hidden" },
      projects: { mode: "hidden" },
    });
    assert.deepEqual(parseDesk(JSON.stringify({ widgetFolded: ["projects"] }), ["/"]).widgets, { projects: { mode: "collapsed" } });
    assert.equal(parseDesk(JSON.stringify({ widgetSide: "left" }), ["/"]).widgets, undefined);
  });
});

describe("the arrangement across the desktop", () => {
  // two columns of icons and a widget beside them: columns 0 to 4, on a 1440px desktop (15 columns)
  const spans = [
    { c: 0, r: 0, w: 1, h: 1 },
    { c: 1, r: 2, w: 1, h: 1 },
    { c: 2, r: 0, w: 3, h: 3 },
  ];
  it("stays where it is against the left", () => {
    assert.equal(alignShift("left", spans, 1440), 0);
  });
  it("goes against the right edge, as far from it as the left edge's padding", () => {
    const shift = alignShift("right", spans, 1440);
    assert.equal(12 + 5 * 92 - 8 + shift, 1440 - 12);
  });
  it("centres what it takes, keeping the gaps in it", () => {
    const shift = alignShift("center", spans, 1440);
    const left = 12 + shift;
    const right = 12 + 5 * 92 - 8 + shift;
    assert.ok(Math.abs(left - (1440 - right)) <= 1);
    assert.equal(alignShift("center", [], 1440), 0);
  });
  it("lets a drop land past the arrangement's first column when it's drawn away from the left, never off screen", () => {
    assert.deepEqual(dropRange(spans, 1, 15, 0, 1440), { lo: 0, hi: 14 });
    const right = dropRange(spans, 1, 15, alignShift("right", spans, 1440), 1440);
    assert.equal(right.hi, 4, "the screen's last column is the arrangement's");
    assert.equal(right.lo, -10, "as far left as keeps the whole 15 columns wide");
    assert.deepEqual(dropRange([], 3, 15, 0, 1440), { lo: 0, hi: 12 });
  });
  it("moves over as a whole to come back on the grid", () => {
    assert.equal(fitShift(spans, 15), 0);
    assert.equal(fitShift([...spans, { c: -2, r: 0, w: 1, h: 1 }], 15), 2);
    assert.equal(fitShift([{ c: 13, r: 0, w: 3, h: 3 }], 15), -1);
    assert.equal(fitShift([], 15), 0);
  });
  it("remembers icons taken off the desktop, the dock's size and the arrangement's side", () => {
    const d = parseDesk(
      JSON.stringify({ removedIcons: ["/files", "/files", "vscode", "/gone", 3], dockSize: 64, align: "right" }),
      ["/", "/files"],
    );
    assert.deepEqual(d.removedIcons, ["/files", "vscode"]);
    assert.equal(d.dockSize, 64);
    assert.equal(d.align, "right");
    const bad = parseDesk(JSON.stringify({ removedIcons: [], dockSize: 500, align: "up" }), ["/"]);
    assert.equal(bad.removedIcons, undefined);
    assert.equal(bad.dockSize, undefined);
    assert.equal(bad.align, undefined);
  });
});

describe("widgets off at first", () => {
  it("are off until put on the desktop, and remember being put on it", () => {
    assert.equal(widgetMode(undefined, "health"), "hidden");
    assert.equal(widgetMode(undefined, "terminals"), "open");
    assert.equal(widgetMode({ health: { mode: "open" } }, "health"), "open");
    assert.deepEqual(parseDesk(JSON.stringify({ widgets: { git: { mode: "open" } } }), ["/"]).widgets, { git: { mode: "open" } });
    assert.deepEqual(Object.keys(deskWidgets(undefined, 15, 7)), ["terminals", "projects", "disk", "memory", "processes", "docker"]);
  });
  it("remember how each shows what it shows, and nothing odd", () => {
    assert.deepEqual(
      parseDesk(JSON.stringify({ widgets: { disk: { views: { chart: "treemap", "x y": "1" } }, memory: { views: { period: "<script>" } } } }), ["/"]).widgets,
      { disk: { views: { chart: "treemap" } } },
    );
  });
});

describe("the stacked desktop", () => {
  it("is for when the arrangement doesn't fit: a widget pushed onto the grid, or an icon past its columns", () => {
    const saved = { terminals: { at: { c: 10, r: 0, w: 3, h: 3 } }, projects: { mode: "hidden" as const }, disk: { mode: "hidden" as const }, memory: { mode: "hidden" as const }, processes: { mode: "hidden" as const }, docker: { mode: "hidden" as const } };
    const wide = widgetWants(saved, 15);
    assert.equal(arrangementFits(wide, deskWidgets(saved, 15, 7), { a: { c: 0, r: 0 } }, 15), true);
    const narrow = widgetWants(saved, 8);
    assert.equal(arrangementFits(narrow, deskWidgets(saved, 8, 7), { a: { c: 0, r: 0 } }, 8), false, "the widget's spot is past the grid");
    assert.equal(arrangementFits(wide, deskWidgets(saved, 15, 7), { a: { c: 15, r: 0 } }, 15), false, "an icon past the columns");
  });
  it("puts the widgets one a row, the whole width, in reading order, then the icons a row after another", () => {
    const s = stackDesktop(
      [
        { id: "b", at: { c: 9, r: 0, w: 3, h: 4 } },
        { id: "a", at: { c: 2, r: 0, w: 3, h: 3 } },
        { id: "c", at: { c: 0, r: 5, w: 3, h: 1 } },
      ],
      ["x", "y", "z"],
      12 + 2 * 92 + 88 + 12,
    );
    assert.deepEqual(s.widgets.a, { x: 20, y: 20, w: 12 + 2 * 92 + 88 + 12 - 40, h: 3 * 96 - 16 });
    assert.equal(s.widgets.b.y, 12 + 3 * 96 + 8);
    assert.equal(s.widgets.c.y, 12 + 7 * 96 + 8);
    assert.deepEqual(s.icons, { x: { c: 0, r: 8 }, y: { c: 1, r: 8 }, z: { c: 2, r: 8 } });
    assert.equal(s.rows, 9);
  });
});

describe("VS Code in the dock", () => {
  it("can be kept in the dock, as the apps are", () => {
    assert.deepEqual(parseDesk(JSON.stringify({ pinned: ["/", "vscode", "vscode", "/gone"] }), ["/"]).pinned, ["/", "vscode"]);
  });
});

describe("a shorter window", () => {
  it("fills the rows that show with the icons never placed, then goes on under them, never past the last column", () => {
    const l = layoutIcons(["a", "b", "c", "d", "e", "f", "g"], undefined, 2, 9, [], 2);
    assert.deepEqual(l, {
      a: { c: 0, r: 0 },
      b: { c: 0, r: 1 },
      c: { c: 1, r: 0 },
      d: { c: 1, r: 1 },
      e: { c: 0, r: 2 },
      f: { c: 1, r: 2 },
      g: { c: 0, r: 3 },
    });
  });
  it("keeps the icons placed by hand where they are, below what shows too", () => {
    assert.deepEqual(layoutIcons(["a"], { a: { c: 1, r: 6 } }, 3, 7, [], 3).a, { c: 1, r: 6 });
  });
});
