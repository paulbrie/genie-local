import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cgroupMemBytes,
  containerEnvKeys,
  containerName,
  defaultImage,
  dockerRunArgs,
  IMAGE_RE,
  pinnedNodeMajor,
  scopeArgs,
  scopeUnit,
} from "./run-isolation";

describe("pinnedNodeMajor", () => {
  it("reads the major of a version, with or without the v, a minor or an x", () => {
    assert.equal(pinnedNodeMajor("v20.11.1\n"), 20);
    assert.equal(pinnedNodeMajor("22"), 22);
    assert.equal(pinnedNodeMajor("22.x"), 22);
    assert.equal(pinnedNodeMajor(" 18 "), 18);
  });

  it("gives up on aliases and nonsense", () => {
    assert.equal(pinnedNodeMajor("lts/iron"), null);
    assert.equal(pinnedNodeMajor("node"), null);
    assert.equal(pinnedNodeMajor("2"), null);
    assert.equal(pinnedNodeMajor("20abc"), null);
  });

  it("the default image is Debian 13's slim Node at that major", () => {
    assert.equal(defaultImage(24), "node:24-trixie-slim");
  });
});

describe("scopeArgs", () => {
  it("runs the command in a user scope, with no caps when none are set", () => {
    assert.deepEqual(scopeArgs("spiridus-a-dev-1.scope", { memMaxMb: null, cpus: null }, ["npm", "run", "dev"]), [
      "--user",
      "--scope",
      "--collect",
      "--unit=spiridus-a-dev-1.scope",
      "--description=Spiridus spiridus-a-dev-1.scope",
      "--",
      "npm",
      "run",
      "dev",
    ]);
  });

  it("caps memory (no swap) and CPU", () => {
    const args = scopeArgs("u.scope", { memMaxMb: 1024, cpus: 1.5 }, ["npm", "run", "dev"]);
    assert.deepEqual(args.slice(5, 11), ["-p", "MemoryMax=1024M", "-p", "MemorySwapMax=0", "-p", "CPUQuota=150%"]);
    assert.deepEqual(args.slice(-4), ["--", "npm", "run", "dev"]);
  });

  it("each run's scope is its own", () => {
    assert.equal(scopeUnit("shop-app-dev", 36 ** 3), "spiridus-shop-app-dev-1000.scope");
    assert.notEqual(scopeUnit("x", 1), scopeUnit("x", 2));
  });
});

describe("dockerRunArgs", () => {
  const base = {
    name: containerName("shop-app-dev"),
    image: "node:24-trixie-slim",
    projectDir: "/opt/project/projects/shop",
    appDir: "/opt/project/projects/shop/app",
    uid: 1000,
    gid: 1001,
    envKeys: ["PORT", "PUBLIC_HOST"],
    memMaxMb: null,
    cpus: null,
    cidFile: "/tmp/projects/shop-app-dev.cid",
    slug: "shop-app-dev",
    argv: ["npm", "run", "dev"],
  };

  it("mounts the project at its own path, on the host's network, as the user, values out of argv", () => {
    assert.deepEqual(dockerRunArgs(base), [
      "run",
      "--rm",
      "--init",
      "--name=spiridus-shop-app-dev",
      "--cidfile=/tmp/projects/shop-app-dev.cid",
      "--label=spiridus.run=shop-app-dev",
      "--network=host",
      "--user=1000:1001",
      "--volume=/opt/project/projects/shop:/opt/project/projects/shop",
      "--workdir=/opt/project/projects/shop/app",
      "--env",
      "PORT",
      "--env",
      "PUBLIC_HOST",
      "node:24-trixie-slim",
      "npm",
      "run",
      "dev",
    ]);
  });

  it("caps memory with no swap, and CPU", () => {
    const args = dockerRunArgs({ ...base, memMaxMb: 512, cpus: 0.5 });
    assert.ok(args.includes("--memory=512m"));
    assert.ok(args.includes("--memory-swap=512m"));
    assert.ok(args.includes("--cpus=0.5"));
    assert.equal(args.indexOf("--cpus=0.5") < args.indexOf("node:24-trixie-slim"), true);
  });

  it("refuses an image that reads as an option, and a path the -v syntax can't hold", () => {
    assert.throws(() => dockerRunArgs({ ...base, image: "--privileged" }));
    assert.throws(() => dockerRunArgs({ ...base, projectDir: "/opt/a:b" }));
    assert.ok(IMAGE_RE.test("ghcr.io/acme/node-dev:22@sha256:abc"));
  });

  it("leaves the host's own variables out of the container", () => {
    assert.deepEqual(containerEnvKeys({ PATH: "/bin", HOME: "/home/genie", PORT: "4100", LANG: "C.UTF-8", XDG_RUNTIME_DIR: "/run/user/1000" }), [
      "PORT",
      "LANG",
    ]);
  });
});

describe("cgroupMemBytes", () => {
  it("counts what's in use, less the page cache it can give back", () => {
    assert.equal(cgroupMemBytes("1000000\n", "anon 600000\nfile 400000\ninactive_file 300000\n"), 700000);
    assert.equal(cgroupMemBytes("max", ""), 0);
  });
});
