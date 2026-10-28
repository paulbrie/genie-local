import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  API_ROUTES,
  apiActionProps,
  matchApi,
  matchPage,
  PAGE_ROUTES,
  pageViewProps,
} from "./activity-routes";

const APP = path.join(import.meta.dirname, "..", "app");

/** The routes the app router would serve, from the folders under src/app. */
function routesOnDisk(file: "page.tsx" | "route.ts"): string[] {
  const out: string[] = [];
  const walk = (dir: string, segs: string[]) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        // Route groups and private folders don't add a segment / a route.
        if (e.name.startsWith("_")) continue;
        walk(path.join(dir, e.name), /^\(.*\)$/.test(e.name) ? segs : [...segs, e.name]);
      } else if (e.name === file) {
        out.push("/" + segs.join("/"));
      }
    }
  };
  walk(APP, []);
  return out.sort();
}

describe("route tables", () => {
  it("list every page under src/app", () => {
    assert.deepEqual([...PAGE_ROUTES].sort(), routesOnDisk("page.tsx"));
  });

  it("list every api route under src/app/api", () => {
    const api = routesOnDisk("route.ts").filter((r) => r.startsWith("/api/"));
    assert.deepEqual([...API_ROUTES].sort(), api);
  });
});

describe("matchPage", () => {
  it("maps concrete paths to their pattern", () => {
    assert.deepEqual(matchPage("/"), { pattern: "/", params: {} });
    assert.deepEqual(matchPage("/projects/genie-brand/files"), {
      pattern: "/projects/[slug]/files",
      params: { slug: "genie-brand" },
    });
    assert.deepEqual(matchPage("/projects/shop/git/abc123"), {
      pattern: "/projects/[slug]/git/[hash]",
      params: { slug: "shop", hash: "abc123" },
    });
    assert.equal(matchPage("/boards/12")?.pattern, "/boards/[id]");
    assert.equal(matchPage("/projects/")?.pattern, "/projects");
  });

  it("returns null for what isn't a page", () => {
    for (const p of ["/nope", "/projects/a/b/c/d", "/icon.svg", "/_next/static/x.js", "/api/stats"]) {
      assert.equal(matchPage(p), null, p);
    }
  });

  it("decodes segments and rejects malformed escapes", () => {
    assert.equal(matchPage("/projects/my%20app")?.params.slug, "my app");
    assert.equal(matchPage("/projects/%E0%A4%A"), null);
  });
});

describe("matchApi", () => {
  it("prefers static segments over dynamic ones", () => {
    assert.equal(matchApi("/api/boards/assets/3/a.png")?.pattern, "/api/boards/assets/[board]/[file]");
    assert.equal(matchApi("/api/boards/3/assets")?.pattern, "/api/boards/[id]/assets");
    assert.equal(matchApi("/api/db/connections/4")?.pattern, "/api/db/connections/[id]");
    assert.equal(matchApi("/api/db/4/query")?.pattern, "/api/db/[id]/query");
  });
});

describe("pageViewProps", () => {
  it("adds the project for project pages only", () => {
    assert.deepEqual(pageViewProps("/projects/genie-brand/files"), {
      path: "/projects/[slug]/files",
      project: "genie-brand",
    });
    assert.deepEqual(pageViewProps("/projects/genie-brand"), {
      path: "/projects/[slug]",
      project: "genie-brand",
    });
    assert.deepEqual(pageViewProps("/boards/7"), { path: "/boards/[id]" });
    assert.equal(pageViewProps("/missing"), null);
  });
});

describe("apiActionProps", () => {
  it("names mutating calls METHOD + pattern", () => {
    assert.deepEqual(apiActionProps("PATCH", "/api/boards/12"), { name: "PATCH /api/boards/[id]" });
    assert.deepEqual(apiActionProps("post", "/api/projects/shop/tasks"), {
      name: "POST /api/projects/[slug]/tasks",
      project: "shop",
    });
    assert.deepEqual(apiActionProps("DELETE", "/api/terminals"), { name: "DELETE /api/terminals" });
  });

  it("skips reads, unknown routes, auth and background calls", () => {
    assert.equal(apiActionProps("GET", "/api/boards/12"), null);
    assert.equal(apiActionProps("HEAD", "/api/stats"), null);
    assert.equal(apiActionProps("POST", "/api/nope"), null);
    for (const p of ["/api/login", "/api/logout", "/api/activity", "/api/narrate", "/api/tts", "/api/diagrams/validate"]) {
      assert.equal(apiActionProps("POST", p), null, p);
    }
  });
});
