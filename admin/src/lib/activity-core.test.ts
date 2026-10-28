import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { activityContextOf, terminalActivity } from "../../server/pty.mjs";
import {
  appendLine,
  buildLine,
  EVENT_PROPS,
  hashIp,
  MAX_PROPS,
  propsFor,
  recordActivity,
  sanitizeProps,
  sessionIdOf,
  SPOOL_MAX_BYTES,
  uaFamily,
  type ActivityEvent,
  type ActivityLine,
} from "./activity-core.mjs";

const KEY = Buffer.alloc(32, 7).toString("base64");
process.env.APP_ENC_KEY = KEY;

const tmp = mkdtempSync(path.join(tmpdir(), "activity-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const CHROME =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

describe("sanitizeProps", () => {
  it("keeps only primitives, drops the rest without stringifying", () => {
    const out = sanitizeProps({
      s: "x",
      n: 3,
      b: false,
      z: null,
      inf: Infinity,
      nan: NaN,
      u: undefined,
      o: { a: 1 },
      a: [1, 2],
      f: () => 1,
      big: BigInt(1),
      sym: Symbol("s"),
      d: new Date(0),
    });
    assert.deepEqual(out, { s: "x", n: 3, b: false, z: null });
  });

  it("cuts strings to 200 chars and keeps at most 12 keys", () => {
    assert.equal((sanitizeProps({ s: "a".repeat(500) }).s as string).length, 200);
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    assert.equal(Object.keys(sanitizeProps(many)).length, MAX_PROPS);
  });

  it("returns {} for anything that isn't a plain object", () => {
    for (const v of [null, undefined, "x", 3, [1, 2], true]) assert.deepEqual(sanitizeProps(v), {});
  });
});

describe("propsFor: nothing forbidden gets in", () => {
  // Everything the contract rules out, under the names it would likely travel by.
  const forbidden = {
    input: "rm -rf /\r",
    output: "\x1b[31mERROR\x1b[0m secret",
    data: "ls -la",
    sql: "select * from users",
    query: "select 1",
    prompt: "summarise this board",
    content: "file body",
    file: "/etc/passwd",
    body: '{"password":"x"}',
    search: "?token=abc",
    qs: "a=1",
    password: "hunter2",
    username: "admin",
    user: "admin",
    token: "abc.def",
    cookie: "admin_session=abc",
    secret: "x",
    ip: "203.0.113.9",
    userAgent: CHROME,
    url: "https://host/admin/projects/x?y=1",
  };

  it("only the event's own keys survive", () => {
    for (const event of Object.keys(EVENT_PROPS)) {
      const out = propsFor(event, { ...forbidden });
      assert.deepEqual(out, {}, event);
    }
  });

  it("allowed keys must have their shape, so contents can't ride on them", () => {
    assert.deepEqual(propsFor("page.view", { path: "/projects/x?token=1" }), {});
    assert.deepEqual(propsFor("page.view", { path: "/projects/x#frag" }), {});
    assert.deepEqual(propsFor("page.view", { path: "https://evil/x" }), {});
    assert.deepEqual(propsFor("page.view", { path: "/projects/[slug]", project: "a/b" }), { path: "/projects/[slug]" });
    assert.deepEqual(propsFor("page.view", { project: "select * from x" }), {});
    assert.deepEqual(propsFor("action", { name: "ls -la; rm -rf /" }), {});
    assert.deepEqual(propsFor("action", { name: "POST /api/x?y=1" }), {});
    assert.deepEqual(propsFor("action", { name: "GET /api/stats" }), {});
    assert.deepEqual(propsFor("action", { ok: "true" }), {});
    assert.deepEqual(propsFor("terminal.attach", { terminal: "\x1b[A" }), {});
    assert.deepEqual(propsFor("terminal.attach", { terminal: "x".repeat(65) }), {});
    assert.deepEqual(propsFor("terminal.detach", { seconds: -1 }), {});
    assert.deepEqual(propsFor("auth.failed", { reason: "wrong password for paul" }), {});
    assert.deepEqual(propsFor("auth.login", { reason: "wrong_password" }), {});
    assert.deepEqual(propsFor("auth.login", { via: "google" }), {});
    assert.deepEqual(propsFor("auth.login", { via: "paul@example.com" }), {});
    assert.deepEqual(propsFor("nope", { path: "/" }), {});
  });

  it("passes the contract's props through", () => {
    assert.deepEqual(propsFor("page.view", { path: "/projects/[slug]/files", project: "genie-brand" }), {
      path: "/projects/[slug]/files",
      project: "genie-brand",
    });
    assert.deepEqual(propsFor("action", { name: "renameDiagramAction", project: "shop", ok: true }), {
      name: "renameDiagramAction",
      project: "shop",
      ok: true,
    });
    assert.deepEqual(propsFor("action", { name: "PATCH /api/boards/[id]" }), { name: "PATCH /api/boards/[id]" });
    assert.deepEqual(propsFor("terminal.detach", { terminal: "my shell", seconds: 12.6 }), {
      terminal: "my shell",
      seconds: 13,
    });
    assert.deepEqual(propsFor("auth.failed", { reason: "wrong_password" }), { reason: "wrong_password" });
    assert.deepEqual(propsFor("auth.failed", { reason: "not_allowed" }), { reason: "not_allowed" });
    assert.deepEqual(propsFor("auth.login", { via: "genie" }), { via: "genie" });
    assert.deepEqual(propsFor("auth.login", { via: "password" }), { via: "password" });
  });
});

describe("buildLine", () => {
  it("has exactly the contract's shape", () => {
    const session = sessionIdOf("cookie.value");
    const line = buildLine(
      "page.view",
      { session, ip: "203.0.113.9", ua: CHROME, props: { path: "/projects/[slug]/files", project: "genie-brand" } },
      1793200000000,
    )!;
    assert.ok(line.endsWith("\n") && !line.slice(0, -1).includes("\n"));
    const obj = JSON.parse(line) as ActivityLine;
    assert.deepEqual(Object.keys(obj), ["v", "id", "ts", "event", "session", "ipHash", "ua", "props"]);
    assert.equal(obj.v, 1);
    assert.match(obj.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(obj.ts, 1793200000000);
    assert.equal(obj.event, "page.view");
    assert.equal(obj.session, session);
    assert.match(obj.ipHash!, /^[0-9a-f]{16}$/);
    assert.equal(obj.ua, "Chrome on Linux");
    assert.deepEqual(obj.props, { path: "/projects/[slug]/files", project: "genie-brand" });
    assert.ok(!line.includes("203.0.113.9"));
    assert.ok(!line.includes("Mozilla"));
  });

  it("nulls what it doesn't have or can't trust", () => {
    const obj = JSON.parse(buildLine("auth.logout", { session: "not-a-session-id", ip: "unknown" })!);
    assert.equal(obj.session, null);
    assert.equal(obj.ipHash, null);
    assert.equal(obj.ua, null);
    assert.deepEqual(obj.props, {});
  });

  it("refuses events outside the allowlist", () => {
    assert.equal(buildLine("terminal.input", { props: { data: "x" } }), null);
    assert.equal(buildLine("", {}), null);
  });

  it("gives each line its own id", () => {
    const a = JSON.parse(buildLine("auth.login")!).id;
    const b = JSON.parse(buildLine("auth.login")!).id;
    assert.notEqual(a, b);
  });
});

describe("who", () => {
  it("sessionIdOf is admin_sessions.id: sha256 of the cookie, 32 hex", () => {
    assert.equal(sessionIdOf("t"), createHash("sha256").update("t").digest("hex").slice(0, 32));
  });

  it("hashIp uses a key derived from APP_ENC_KEY, not the key itself", () => {
    const h = hashIp("203.0.113.9", KEY)!;
    assert.match(h, /^[0-9a-f]{16}$/);
    assert.equal(hashIp("203.0.113.9", KEY), h);
    assert.notEqual(hashIp("203.0.113.10", KEY), h);
    const raw = Buffer.from(KEY, "base64");
    assert.notEqual(createHmac("sha256", raw).update("203.0.113.9").digest("hex").slice(0, 16), h);
    assert.notEqual(createHmac("sha256", KEY).update("203.0.113.9").digest("hex").slice(0, 16), h);
    const derived = createHmac("sha256", raw).update("activity-ip").digest();
    assert.equal(createHmac("sha256", derived).update("203.0.113.9").digest("hex").slice(0, 16), h);
    assert.equal(hashIp("203.0.113.9", ""), null);
    assert.equal(hashIp(null, KEY), null);
  });

  it("uaFamily is browser + OS only, ≤60 chars, never the raw string", () => {
    assert.equal(uaFamily(CHROME), "Chrome on Linux");
    assert.equal(
      uaFamily("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"),
      "Safari on macOS",
    );
    assert.equal(uaFamily("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0"), "Firefox on Windows");
    assert.equal(uaFamily(`${CHROME} Edg/141.0.0.0`.replace("X11; Linux x86_64", "Windows NT 10.0")), "Edge on Windows");
    assert.equal(
      uaFamily("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1"),
      "Chrome on iOS",
    );
    assert.equal(uaFamily(CHROME.replace("Chrome/", "HeadlessChrome/")), "Headless Chrome on Linux");
    assert.equal(uaFamily("curl/8.5.0"), "curl");
    assert.equal(uaFamily("my secret tool v1 with a long story ".repeat(5)), null);
    assert.equal(uaFamily(null), null);
  });
});

describe("appendLine / recordActivity", () => {
  it("creates the spool's directory and appends whole lines", async () => {
    const file = path.join(tmp, "deep", "er", "activity.jsonl");
    assert.equal(await recordActivity("auth.login", { session: sessionIdOf("x") }, file), true);
    assert.equal(await recordActivity("auth.failed", { props: { reason: "wrong_password" } }, file), true);
    const lines = readFileSync(file, "utf8").split("\n");
    assert.equal(lines.pop(), "");
    assert.deepEqual(lines.map((l) => JSON.parse(l).event), ["auth.login", "auth.failed"]);
  });

  it("stops writing while the spool is over 50 MB", async () => {
    const file = path.join(tmp, "full.jsonl");
    writeFileSync(file, "");
    truncateSync(file, SPOOL_MAX_BYTES + 1); // sparse: no real 50 MB on disk
    assert.equal(await appendLine(buildLine("auth.login")!, file), false);
    assert.equal(statSync(file).size, SPOOL_MAX_BYTES + 1);
    truncateSync(file, SPOOL_MAX_BYTES); // at the cap is still fine
    assert.equal(await appendLine(buildLine("auth.login")!, file), true);
  });

  it("never throws or rejects", async () => {
    const unwritable = path.join(tmp, "full.jsonl", "under-a-file.jsonl");
    assert.equal(await recordActivity("auth.login", {}, unwritable), false);
    assert.equal(await recordActivity("bogus" as ActivityEvent, {}, path.join(tmp, "x.jsonl")), false);
    const hostile = {
      get path() {
        throw new Error("boom");
      },
    };
    assert.equal(await recordActivity("page.view", { props: hostile }, path.join(tmp, "x.jsonl")), false);
  });
});

describe("server/pty.mjs terminal events", () => {
  it("attach on start, detach once with the seconds attached", () => {
    const seen: { event: string; props: unknown; session: unknown }[] = [];
    let t = 1_000_000;
    const record = (event: string, ctx?: { props?: unknown; session?: unknown }) => {
      seen.push({ event, props: ctx?.props, session: ctx?.session });
      return Promise.resolve(true);
    };
    const ctx = { session: "a".repeat(32), ip: "203.0.113.9", ua: CHROME };
    const detach = terminalActivity(ctx, "work", record, () => t);
    t += 61_400;
    detach();
    detach(); // close after error: still one detach
    assert.deepEqual(seen, [
      { event: "terminal.attach", props: { terminal: "work" }, session: ctx.session },
      { event: "terminal.detach", props: { terminal: "work", seconds: 61 }, session: ctx.session },
    ]);
  });

  it("reads who from the upgrade request", () => {
    const req = {
      headers: { cookie: "x=1; admin_session=tok.sig", "x-real-ip": "203.0.113.9", "user-agent": CHROME },
    };
    assert.deepEqual(activityContextOf(req), { session: sessionIdOf("tok.sig"), ip: "203.0.113.9", ua: CHROME });
    assert.deepEqual(activityContextOf(undefined), {});
  });
});
