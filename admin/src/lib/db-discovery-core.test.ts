import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type ContainerInfo, connFromContainer, connFromUrl, connKey, dbUrlsInEnv, mergeFound } from "./db-discovery-core";

describe("connFromUrl", () => {
  it("reads a local postgres or mysql URL, decoding the user and password", () => {
    assert.deepEqual(connFromUrl("postgresql://acccess_user:p%40ss@localhost:5432/acccess_dev?schema=public"), {
      engine: "postgres",
      host: "127.0.0.1",
      port: 5432,
      username: "acccess_user",
      password: "p@ss",
      defaultDatabase: "acccess_dev",
    });
    assert.deepEqual(connFromUrl("mysql://root@127.0.0.1/shop"), {
      engine: "mysql",
      host: "127.0.0.1",
      port: 3306,
      username: "root",
      password: null,
      defaultDatabase: "shop",
    });
    assert.equal(connFromUrl("postgres://u:p@[::1]:5548/x")?.port, 5548);
  });
  it("leaves out a database somewhere else, and what isn't a database URL", () => {
    assert.equal(connFromUrl("postgresql://postgres:x@caboose.proxy.rlwy.net:52574/railway"), null);
    assert.equal(connFromUrl("https://localhost:5432/x"), null);
    assert.equal(connFromUrl("postgres://"), null);
  });
});

describe("dbUrlsInEnv", () => {
  it("finds database URLs, quoted, exported or with a comment after", () => {
    const text = [
      "# DATABASE_URL=postgres://commented@localhost/x",
      'DATABASE_URL="postgresql://a:b@localhost:5432/one"',
      "export SHADOW_URL='mysql://c@localhost/two' # the shadow",
      "OTHER=postgres://d@localhost/three  # note",
      "API_URL=https://example.com",
      "EMPTY=",
    ].join("\n");
    assert.deepEqual(dbUrlsInEnv(text), ["postgresql://a:b@localhost:5432/one", "mysql://c@localhost/two", "postgres://d@localhost/three"]);
  });
});

describe("connFromContainer", () => {
  const pg = (over: Partial<ContainerInfo> = {}): ContainerInfo => ({
    name: "mecharena-postgres-1",
    image: "postgres:17-alpine",
    env: ["POSTGRES_USER=mecharena", "POSTGRES_PASSWORD=secret", "POSTGRES_DB=mecharena", "PGDATA=/var/lib/postgresql/data"],
    ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5548" }] },
    ip: "172.18.0.2",
    hostNetwork: false,
    ...over,
  });
  it("takes what a postgres container sets up, at the port it publishes", () => {
    assert.deepEqual(connFromContainer(pg()), {
      engine: "postgres",
      host: "127.0.0.1",
      port: 5548,
      username: "mecharena",
      password: "secret",
      defaultDatabase: "mecharena",
    });
  });
  it("reaches one that publishes nothing at its address on its network", () => {
    const c = connFromContainer(pg({ ports: { "5432/tcp": null } }));
    assert.equal(c?.host, "172.18.0.2");
    assert.equal(c?.port, 5432);
  });
  it("has postgres's defaults, and leaves out one whose password it can't know", () => {
    const c = connFromContainer(pg({ env: ["POSTGRES_HOST_AUTH_METHOD=trust"] }));
    assert.equal(c?.username, "postgres");
    assert.equal(c?.defaultDatabase, "postgres");
    assert.equal(connFromContainer(pg({ env: ["POSTGRES_PASSWORD_FILE=/run/secrets/pg"] })), null);
  });
  it("knows mysql and mariadb, root first, and leaves out what isn't a database", () => {
    const my = connFromContainer(
      pg({ image: "mariadb:11", env: ["MARIADB_ROOT_PASSWORD=r", "MARIADB_DATABASE=shop"], ports: { "3306/tcp": [{ HostIp: "0.0.0.0", HostPort: "3307" }] } }),
    );
    assert.deepEqual(my, { engine: "mysql", host: "127.0.0.1", port: 3307, username: "root", password: "r", defaultDatabase: "shop" });
    assert.equal(connFromContainer(pg({ image: "mysql:8", env: ["MYSQL_USER=app", "MYSQL_PASSWORD=p"], ports: {} }))?.username, "app");
    assert.equal(connFromContainer(pg({ image: "redis:7" })), null);
    assert.equal(connFromContainer(pg({ image: "prometheuscommunity/postgres-exporter" })), null);
    assert.equal(connFromContainer(pg({ image: "postgis/postgis:16-3.4" }))?.engine, "postgres");
  });
});

describe("mergeFound", () => {
  it("is one connection per server and user, named by the first that found it", () => {
    const own = connFromUrl("postgresql://admin_app:x@localhost:5432/admin_dashboard")!;
    const garden = connFromUrl("postgresql://admin_app:x@127.0.0.1:5432/garden")!;
    const other = connFromUrl("postgresql://html_editor_app:y@localhost:5432/html_editor")!;
    const found = mergeFound([
      { conn: own, name: "This server", from: "the admin's DATABASE_URL" },
      { conn: garden, name: "garden", from: "garden/.env.local" },
      { conn: other, name: "html-editor", from: "html-editor/.env.local" },
    ]);
    assert.equal(found.length, 2);
    assert.equal(found[0].name, "This server");
    assert.equal(found[0].defaultDatabase, "admin_dashboard");
    assert.deepEqual(found[0].from, ["the admin's DATABASE_URL", "garden/.env.local"]);
    assert.equal(found[0].key, connKey(garden));
  });
});
