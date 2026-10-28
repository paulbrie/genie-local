import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GENIE_CALLBACK, isPublicPath, skipsOriginCheck } from "./proxy-rules";

describe("skipsOriginCheck", () => {
  it("lets exactly the Sign in with Genie callback POST through", () => {
    assert.equal(skipsOriginCheck(GENIE_CALLBACK, "POST"), true);
    assert.equal(skipsOriginCheck(GENIE_CALLBACK, "post"), true);
  });

  it("only POST", () => {
    for (const m of ["PUT", "PATCH", "DELETE"]) assert.equal(skipsOriginCheck(GENIE_CALLBACK, m), false);
  });

  it("only that route", () => {
    for (const p of [
      "/api/auth/genie/start",
      "/api/auth/genie/callback/x",
      "/api/auth/genie/callbackx",
      "/api/auth/genie",
      "/api/auth/genie/",
      "/api/boards/1/ops",
      "/api/logout",
      "/login",
      "/",
    ]) {
      assert.equal(skipsOriginCheck(p, "POST"), false, p);
    }
  });

  it("still leaves /api/login to check the origin itself", () => {
    assert.equal(skipsOriginCheck("/api/login", "POST"), true);
  });
});

describe("isPublicPath", () => {
  it("Sign in with Genie routes are public", () => {
    assert.equal(isPublicPath("/api/auth/genie/start", "GET"), true);
    assert.equal(isPublicPath(GENIE_CALLBACK, "POST"), true);
  });

  it("the login page (GET only) and the login / logout routes", () => {
    assert.equal(isPublicPath("/login", "GET"), true);
    assert.equal(isPublicPath("/login", "POST"), false);
    assert.equal(isPublicPath("/api/login", "POST"), true);
    assert.equal(isPublicPath("/api/logout", "POST"), true);
  });

  it("nothing else", () => {
    for (const p of ["/", "/users", "/logins", "/api/auth", "/api/auth/genie", "/api/authcheck", "/api/sessions", "/api/auth-genie/start"]) {
      assert.equal(isPublicPath(p, "GET"), false, p);
    }
  });
});
