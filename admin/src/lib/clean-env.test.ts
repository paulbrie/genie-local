import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cleanEnv, keepEnvKey, staleTmuxEnvKeys } from "./clean-env.mjs";

// What admin.service's process.env looks like once Next has loaded .env.local.
const ADMIN_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/genie",
  USER: "genie",
  LOGNAME: "genie",
  SHELL: "/bin/bash",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  NODE_ENV: "production",
  PORT: "3002",
  APP_BASE_PATH: "/admin",
  NEXT_PUBLIC_BASE_PATH: "/admin",
  APP_DIST_DIR: ".next-prod",
  APP_PUBLIC_HOSTS: "box.example.com",
  PUBLIC_HOST: "box.example.com",
  DATABASE_URL: "postgres://admin_app:x@localhost/admin_dashboard",
  APP_ENC_KEY: "k",
  SLACK_BOT_TOKEN: "xoxb",
  RAILWAY_API_TOKEN: "r",
  TURBOPACK: "1",
  __NEXT_PROCESSED_ENV: "true",
  INVOCATION_ID: "abc",
};

describe("cleanEnv", () => {
  it("keeps the user's basics, the locale and the public host, and nothing of the admin's", () => {
    assert.deepEqual(cleanEnv(ADMIN_ENV), {
      PATH: "/usr/bin:/bin",
      HOME: "/home/genie",
      USER: "genie",
      LOGNAME: "genie",
      SHELL: "/bin/bash",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PUBLIC_HOST: "box.example.com",
    });
  });

  it("adds what the caller sets, over what it kept", () => {
    const env = cleanEnv(ADMIN_ENV, { PORT: "4100", FORCE_COLOR: "0", HOME: "/tmp" });
    assert.equal(env.PORT, "4100");
    assert.equal(env.FORCE_COLOR, "0");
    assert.equal(env.HOME, "/tmp");
    assert.equal(env.NODE_ENV, undefined);
  });

  it("a variable the admin gains later isn't passed on by default", () => {
    assert.equal(keepEnvKey("SOME_NEW_TOKEN"), false);
    assert.equal(keepEnvKey("LC_TIME"), true);
  });
});

describe("staleTmuxEnvKeys", () => {
  it("picks what came from an admin, leaving the kept ones and anyone else's", () => {
    const keys = ["PATH", "HOME", "NODE_ENV", "PORT", "DATABASE_URL", "SSH_AUTH_SOCK", "DISPLAY", "TURBOPACK", "__NEXT_PROCESSED_ENV"];
    assert.deepEqual(staleTmuxEnvKeys(keys, ADMIN_ENV), ["NODE_ENV", "PORT", "DATABASE_URL", "TURBOPACK", "__NEXT_PROCESSED_ENV"]);
  });

  it("knows the other instance's and older admins' names without them in this env", () => {
    const keys = ["TURBOPACK", "NEXT_DEPLOYMENT_ID", "BOARDS_API_KEY", "SLACK_APP_TOKEN", "APP_DIST_DIR", "EDITOR"];
    assert.deepEqual(staleTmuxEnvKeys(keys, { PATH: "/bin" }), ["TURBOPACK", "NEXT_DEPLOYMENT_ID", "BOARDS_API_KEY", "SLACK_APP_TOKEN", "APP_DIST_DIR"]);
  });
});
