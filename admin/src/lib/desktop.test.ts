import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appOf,
  atRest,
  clampRect,
  defaultGeom,
  magnify,
  MAGNIFY,
  maxRect,
  MIN_WIN,
  parseDesk,
  parseShellMode,
  resizeRect,
  subPath,
  unmaximizeUnder,
  gridSize,
  cellsRect,
  defaultWidgetAt,
  deskWidgets,
  moveCells,
  overlaps,
  placeWidgets,
  resizeCells,
  WIDGET_MIN,
  alignShift,
  dropRange,
  fitShift,
  widgetMode,
  arrangementFits,
  NAV_ALWAYS,
  navShown,
  SIDEBAR_ICON,
  sidebarWidth,
  sideGlyph,
  stackDesktop,
  tileSlot,
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
  // (the workspace is right of the sidebar and under the top bar: nothing in it is kept clear for either)
  it("a first window fills the workspace, a small margin around it", () => {
    assert.deepEqual(defaultGeom(1600, 900), { x: 24, y: 12, w: 1600 - 48, h: 900 - 24 });
  });
  it("a first window on a narrow screen fills the width", () => {
    const g = defaultGeom(1000, 700);
    assert.ok(g.x <= 24);
    assert.ok(g.x + g.w <= 1000);
  });
  it("maximized fills the whole workspace, a small gap around it", () => {
    assert.deepEqual(maxRect(1200, 800), { x: 8, y: 8, w: 1184, h: 784 });
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
    for (const raw of [null, "", "nope", "[]", "42"]) assert.deepEqual(parseDesk(raw, APPS), { geoms: {} });
  });
  it("keeps known apps only, and valid geometry only", () => {
    const raw = JSON.stringify({
      geoms: {
        "/files": { x: 1, y: 2, w: 300, h: 200, max: true },
        "/": { x: 1, y: 2, w: 0, h: 200 },
        "/terminals": { x: "1", y: 2, w: 300, h: 200 },
        "/gone": { x: 1, y: 2, w: 300, h: 200 },
        "/boards": { x: 0, y: 0, w: 500, h: 300, max: "yes" },
      },
    });
    assert.deepEqual(parseDesk(raw, APPS), {
      geoms: { "/files": { x: 1, y: 2, w: 300, h: 200, max: true }, "/boards": { x: 0, y: 0, w: 500, h: 300 } },
    });
  });
  it("lets go of what the dock kept (its apps, VS Code)", () => {
    assert.deepEqual(parseDesk(JSON.stringify({ pinned: ["/", "vscode", "/files"] }), APPS), { geoms: {} });
  });
  it("lets go of the desktop's icons, and the ones taken off it, keeping the rest", () => {
    const d = parseDesk(
      JSON.stringify({
        icons: { "/files": { c: 2, r: 1 }, vscode: { c: 0, r: 3 } },
        removedIcons: ["/files", "vscode"],
        widgets: { git: { mode: "open" } },
        align: "right",
      }),
      APPS,
    );
    assert.deepEqual(d, { geoms: {}, widgets: { git: { mode: "open" } }, align: "right" });
  });
});

describe("the desktop's grid", () => {
  it("fits as many columns and rows as the desktop has room for", () => {
    assert.deepEqual(gridSize(1440, 860), { cols: 15, rows: 8 });
  });
  it("takes the whole height, inset as from the sides", () => {
    assert.equal(gridSize(1440, 12 + 7 * 96 + 12).rows, 7);
    assert.equal(gridSize(1440, 12 + 7 * 96 + 11).rows, 6);
    assert.equal(gridSize(1440, 50).rows, 1, "always one");
  });
});

describe("desktop widgets", () => {
  it("are three cells by three at the least, inset so two side by side are 16px apart", () => {
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
  // two widgets: columns 0 to 4, on a 1440px desktop (15 columns); what shows is inset 8px in its span
  const spans = [
    { c: 0, r: 0, w: 3, h: 3 },
    { c: 2, r: 3, w: 3, h: 4 },
  ];
  const leftEdge = 12 + 8;
  const rightEdge = 12 + 5 * 92 - 8;
  it("stays where it is against the left", () => {
    assert.equal(alignShift("left", spans, 1440), 0);
  });
  it("goes against the right edge, as far from it as the first widget is from the left against the left", () => {
    const shift = alignShift("right", spans, 1440);
    assert.equal(rightEdge + shift, 1440 - leftEdge);
  });
  it("centres what it takes, keeping the gaps in it", () => {
    const shift = alignShift("center", spans, 1440);
    assert.ok(Math.abs(leftEdge + shift - (1440 - (rightEdge + shift))) <= 1);
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
  it("remembers the sidebar's size and the arrangement's side", () => {
    const d = parseDesk(JSON.stringify({ sidebarSize: 32, align: "right" }), ["/"]);
    assert.equal(d.sidebarSize, 32);
    assert.equal(d.align, "right");
    const bad = parseDesk(JSON.stringify({ sidebarSize: 500, align: "up" }), ["/"]);
    assert.equal(bad.sidebarSize, undefined);
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
  it("is only for when the widgets, as put, are wider than the desktop", () => {
    const at = (c: number, w = 3) => ({ at: { c, r: 0, w, h: 3 } });
    assert.equal(arrangementFits([at(10), at(4)], 15), true);
    assert.equal(arrangementFits([at(10), at(4)], 12), true, "columns 4 to 12, 9 wide: past 12 columns, but the lot moves over");
    assert.equal(arrangementFits([at(10), at(4)], 9), true, "9 wide fits 9 columns");
    assert.equal(arrangementFits([at(10), at(4)], 8), false);
    assert.equal(arrangementFits([], 3), true);
  });
  it("counts only the widgets put by hand, but a default spot with no room at all", () => {
    const mine = (c: number) => ({ at: { c, r: 0, w: 3, h: 3 }, custom: true });
    const dflt = (c: number) => ({ at: { c, r: 4, w: 3, h: 3 }, custom: false });
    assert.equal(arrangementFits([mine(5), mine(11), dflt(1)], 10), true, "columns 5 to 13 are mine: 9 wide; the default one finds room");
    assert.equal(arrangementFits([mine(5), dflt(-2)], 10), false, "no room for a default one");
  });
  it("isn't for two widgets on one spot (a new one at its default): that one finds a free spot", () => {
    assert.equal(arrangementFits([at2(6, 0), at2(6, 0)], 15), true);
    function at2(c: number, r: number) {
      return { at: { c, r, w: 3, h: 3 } };
    }
  });
  it("puts the widgets one a row, the whole width, in reading order", () => {
    const s = stackDesktop(
      [
        { id: "b", at: { c: 9, r: 0, w: 3, h: 4 } },
        { id: "a", at: { c: 2, r: 0, w: 3, h: 3 } },
        { id: "c", at: { c: 0, r: 5, w: 3, h: 1 } },
      ],
      12 + 2 * 92 + 88 + 12,
    );
    assert.deepEqual(s.widgets.a, { x: 20, y: 20, w: 12 + 2 * 92 + 88 + 12 - 40, h: 3 * 96 - 16 });
    assert.equal(s.widgets.b.y, 12 + 3 * 96 + 8);
    assert.equal(s.widgets.c.y, 12 + 7 * 96 + 8);
    assert.equal(s.rows, 8);
  });
});

describe("the sidebar's items", () => {
  it("are all shown until some are left out, and never the home or Settings", () => {
    assert.ok(navShown(undefined, "/files"));
    assert.ok(!navShown(["/files"], "/files"));
    assert.ok(navShown(["/files"], "/boards"));
    for (const id of NAV_ALWAYS) assert.ok(navShown([id], id), id);
  });
  it("remember which are left out: known ones once each, VS Code too, never the home or Settings", () => {
    const d = parseDesk(JSON.stringify({ hiddenNav: ["/files", "/files", "vscode", "/gone", 3, "/", "/settings", null] }), [...APPS, "/settings"]);
    assert.deepEqual(d.hiddenNav, ["/files", "vscode"]);
    assert.equal(parseDesk(JSON.stringify({ hiddenNav: [] }), APPS).hiddenNav, undefined);
    assert.equal(parseDesk(JSON.stringify({ hiddenNav: "/files" }), APPS).hiddenNav, undefined);
    assert.equal(parseDesk(JSON.stringify({ hiddenNav: { "/files": true } }), APPS).hiddenNav, undefined);
  });
});

describe("the sidebar, in the desktop", () => {
  it("takes the dock's size over, at the same place in the range (half), when it has none of its own", () => {
    assert.equal(parseDesk(JSON.stringify({ dockSize: 64 }), ["/"]).sidebarSize, 32);
    assert.equal(parseDesk(JSON.stringify({ dockSize: 32 }), ["/"]).sidebarSize, SIDEBAR_ICON.min);
    assert.equal(parseDesk(JSON.stringify({ dockSize: 80 }), ["/"]).sidebarSize, SIDEBAR_ICON.max);
    assert.equal(parseDesk(JSON.stringify({ dockSize: 64, sidebarSize: 20 }), ["/"]).sidebarSize, 20);
    assert.equal(parseDesk(JSON.stringify({ dockSize: 2 }), ["/"]).sidebarSize, undefined);
  });
  it("gives each icon the room it grows to, and is classic's width at the default size", () => {
    assert.equal(sideGlyph(SIDEBAR_ICON.default), 15, "classic's icon");
    assert.equal(sideGlyph(SIDEBAR_ICON.max), 25);
    assert.equal(tileSlot(24), Math.round(15 * (1 + MAGNIFY.by)));
    assert.equal(sidebarWidth(SIDEBAR_ICON.default, false), 224, "classic's");
    assert.equal(sidebarWidth(SIDEBAR_ICON.default, true), 56, "classic's rail");
    assert.ok(sidebarWidth(SIDEBAR_ICON.max, true) >= sideGlyph(SIDEBAR_ICON.max) * (1 + MAGNIFY.by) + 12 + 10, "the list's padding, a scrollbar");
  });

  // ten rows of 32px, 24px icons, at rest
  const rows = Array.from({ length: 10 }, (_, i) => ({ top: i * 32, h: 32 }));
  it("swells the item under the pointer most, its neighbours less, the far ones not at all", () => {
    const { scales } = magnify(rows, 5 * 32 + 16, 24);
    assert.equal(scales[5], 1 + MAGNIFY.by);
    assert.ok(scales[4] < scales[5] && scales[4] > 1);
    assert.equal(scales[4], scales[6], "the same either side");
    assert.ok(scales[3] < scales[4]);
    assert.equal(scales[0], 1);
    assert.equal(scales[9], 1);
  });
  it("draws the list up by what grew above the pointer, so the point under it stays there", () => {
    const size = 24;
    for (const y of [3, 100, 5 * 32 + 16, 170, 300]) {
      const { scales, shift } = magnify(rows, y, size);
      // where the point at y is drawn: its row's top, pushed down by the rows above, plus its way into its own row
      const k = rows.findIndex((r) => y >= r.top && y < r.top + r.h);
      const above = scales.slice(0, k).reduce((sum, s) => sum + (s - 1) * size, 0);
      const into = ((y - rows[k].top) / rows[k].h) * (rows[k].h + (scales[k] - 1) * size);
      assert.ok(Math.abs(rows[k].top + above + into - shift - y) < 1e-9, `y = ${y}`);
    }
    assert.equal(magnify(rows, -50, 24).shift, 0, "nothing grows above the first");
  });
  it("finds where the items are at rest from where they're drawn mid-swell", () => {
    const size = 24;
    const { scales, shift } = magnify(rows, 140, size);
    let above = 0;
    const drawn = rows.map((r, i) => {
      const grow = (scales[i] - 1) * size;
      const d = { top: r.top + above - shift, h: r.h + grow, grow };
      above += grow;
      return d;
    });
    atRest(drawn, shift).forEach((r, i) => {
      assert.ok(Math.abs(r.top - rows[i].top) < 1e-9);
      assert.ok(Math.abs(r.h - rows[i].h) < 1e-9);
    });
  });
});

describe("a widget with no room on the grid", () => {
  it("goes under the others rather than on one, the desktop growing", () => {
    const p = placeWidgets(
      [
        { id: "a", at: { c: 0, r: 0, w: 3, h: 3 } },
        { id: "b", at: { c: 3, r: 0, w: 3, h: 3 } },
        { id: "c", at: { c: 0, r: 0, w: 3, h: 3 } },
      ],
      6,
      3,
    );
    assert.deepEqual(p.c, { c: 0, r: 3, w: 3, h: 3 });
    assert.ok(!overlaps(p.c, p.a) && !overlaps(p.c, p.b));
  });
});
