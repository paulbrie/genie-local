import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  accountDecision,
  createJwksCache,
  managerStartUrl,
  newNonce,
  parseGenieIdentity,
  parseJwks,
  verifyAssertion,
  type GenieIdentity,
  type VerifyOptions,
} from "./genie-sso-core";
import { createSessionToken, readSessionToken, sessionEmail, userSubject, verifySessionToken } from "./session";

process.env.APP_ENC_KEY = Buffer.alloc(32, 9).toString("base64");

// Two Ed25519 keys: A is published from the start, B only after a "rotation".
const keyA = generateKeyPairSync("ed25519");
const keyB = generateKeyPairSync("ed25519");
const jwkOf = (pub: KeyObject, kid: string) => ({ ...pub.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" });

// A fake manager serving /api/vps/sso/jwks, counting fetches.
let published: object[] = [];
let jwksFetches = 0;
let server: Server;
let identity: GenieIdentity;

before(async () => {
  server = createServer((req, res) => {
    if (req.url !== "/api/vps/sso/jwks") {
      res.writeHead(404).end();
      return;
    }
    jwksFetches++;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=300" });
    res.end(JSON.stringify({ keys: published }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  identity = {
    managerUrl: `http://127.0.0.1:${port}`,
    projectId: "11111111-2222-3333-4444-555555555555",
    instanceId: "inst-42",
    publicOrigin: null,
  };
});
after(() => server.close());

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

function makeToken(
  claims: Record<string, unknown> = {},
  { key = keyA.privateKey, kid = "a", header = {} }: { key?: KeyObject; kid?: string; header?: object } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: "EdDSA", typ: "JWT", kid, ...header });
  const p = b64({
    iss: identity.managerUrl,
    aud: `genie-vps:${identity.instanceId}`,
    sub: "genie-user-1",
    email: "alice@example.com",
    name: "Alice",
    project: identity.projectId,
    nonce: NONCE,
    iat: now,
    exp: now + 120,
    jti: randomUUID(),
    ...claims,
  });
  return `${h}.${p}.${sign(null, Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
}

const NONCE = newNonce();
let seen: Map<string, number>;
let jwks: ReturnType<typeof createJwksCache>;
let clock: number;

function opts(extra: Partial<VerifyOptions> = {}): VerifyOptions {
  return {
    identity,
    nonce: NONCE,
    keyFor: (kid) => jwks.key(identity.managerUrl, kid),
    // The in-memory twin of markJtiUsed (genie-sso.ts): first use wins.
    markJti: async (jti, exp) => {
      if (seen.has(jti)) return false;
      seen.set(jti, exp);
      return true;
    },
    ...extra,
  };
}

beforeEach(() => {
  published = [jwkOf(keyA.publicKey, "a")];
  jwksFetches = 0;
  seen = new Map();
  clock = Date.now();
  jwks = createJwksCache({ now: () => clock });
});

describe("verifyAssertion", () => {
  it("accepts a good token and returns who it is", async () => {
    const r = await verifyAssertion(makeToken({ email: "Alice@Example.com " }), opts());
    assert.equal(r.ok, true);
    assert.ok(r.ok);
    assert.equal(r.claims.email, "alice@example.com");
    assert.equal(r.claims.sub, "genie-user-1");
    assert.equal(r.claims.name, "Alice");
    assert.equal(jwksFetches, 1);
  });

  it("refuses a bad signature", async () => {
    // Signed by B but claiming A's kid.
    assert.deepEqual(await verifyAssertion(makeToken({}, { key: keyB.privateKey }), opts()), {
      ok: false,
      reason: "bad_signature",
    });
    // A payload changed after signing.
    const [h, , s] = makeToken().split(".");
    const forged = `${h}.${b64({ email: "mallory@example.com" })}.${s}`;
    assert.deepEqual(await verifyAssertion(forged, opts()), { ok: false, reason: "bad_signature" });
  });

  it("refetches the JWKS once for an unknown kid (a rotation), and only when allowed", async () => {
    assert.equal((await verifyAssertion(makeToken(), opts())).ok, true);
    assert.equal(jwksFetches, 1);
    published = [jwkOf(keyA.publicKey, "a"), jwkOf(keyB.publicKey, "b")];
    // Right after a fetch the refetch is throttled, so a made-up kid can't pump the manager.
    const b = () => makeToken({}, { key: keyB.privateKey, kid: "b" });
    assert.deepEqual(await verifyAssertion(b(), opts()), { ok: false, reason: "unknown_kid" });
    assert.equal(jwksFetches, 1);
    clock += 11_000;
    assert.equal((await verifyAssertion(b(), opts())).ok, true);
    assert.equal(jwksFetches, 2);
    // Known kids within the 5 min cache: no more fetches.
    assert.equal((await verifyAssertion(makeToken(), opts())).ok, true);
    assert.equal(jwksFetches, 2);
    // A kid the manager doesn't have either: one refetch, then refused.
    clock += 11_000;
    assert.deepEqual(await verifyAssertion(makeToken({}, { kid: "zzz" }), opts()), { ok: false, reason: "unknown_kid" });
    assert.equal(jwksFetches, 3);
  });

  it("refetches once the cache is 5 min old", async () => {
    await verifyAssertion(makeToken(), opts());
    clock += 5 * 60_000;
    await verifyAssertion(makeToken(), opts());
    assert.equal(jwksFetches, 2);
  });

  it("refuses the wrong issuer, audience or project", async () => {
    assert.deepEqual(await verifyAssertion(makeToken({ iss: "https://evil.example" }), opts()), { ok: false, reason: "bad_iss" });
    assert.deepEqual(await verifyAssertion(makeToken({ aud: "genie-vps:other" }), opts()), { ok: false, reason: "bad_aud" });
    assert.deepEqual(await verifyAssertion(makeToken({ aud: undefined }), opts()), { ok: false, reason: "bad_aud" });
    assert.deepEqual(await verifyAssertion(makeToken({ project: "another-project" }), opts()), { ok: false, reason: "bad_project" });
  });

  it("refuses an expired token, allowing 60 s of skew", async () => {
    const now = Math.floor(Date.now() / 1000);
    assert.deepEqual(await verifyAssertion(makeToken({ iat: now - 300, exp: now - 61 }), opts()), {
      ok: false,
      reason: "expired",
    });
    assert.equal((await verifyAssertion(makeToken({ iat: now - 150, exp: now - 30 }), opts())).ok, true);
  });

  it("refuses an iat in the future (beyond the skew) and an odd lifetime", async () => {
    const now = Math.floor(Date.now() / 1000);
    assert.deepEqual(await verifyAssertion(makeToken({ iat: now + 120, exp: now + 240 }), opts()), {
      ok: false,
      reason: "future_iat",
    });
    assert.equal((await verifyAssertion(makeToken({ iat: now + 30, exp: now + 150 }), opts())).ok, true);
    assert.deepEqual(await verifyAssertion(makeToken({ iat: now, exp: now + 3600 }), opts()), { ok: false, reason: "bad_lifetime" });
  });

  it("refuses a nonce that isn't the cookie's, or no cookie", async () => {
    assert.deepEqual(await verifyAssertion(makeToken({ nonce: newNonce() }), opts()), { ok: false, reason: "bad_nonce" });
    assert.deepEqual(await verifyAssertion(makeToken(), opts({ nonce: null })), { ok: false, reason: "bad_nonce" });
    assert.deepEqual(await verifyAssertion(makeToken({ nonce: undefined }), opts()), { ok: false, reason: "bad_nonce" });
  });

  it("refuses a replayed jti, and doesn't use one up on a refused token", async () => {
    const token = makeToken();
    assert.equal((await verifyAssertion(token, opts())).ok, true);
    assert.deepEqual(await verifyAssertion(token, opts()), { ok: false, reason: "replayed" });
    const jti = randomUUID();
    assert.equal((await verifyAssertion(makeToken({ jti, nonce: "wrong" }), opts())).ok, false);
    assert.equal(seen.has(jti), false);
    assert.equal((await verifyAssertion(makeToken({ jti }), opts())).ok, true);
  });

  it("keeps a jti until the token's exp plus the skew", async () => {
    const now = Math.floor(Date.now() / 1000);
    const jti = randomUUID();
    await verifyAssertion(makeToken({ jti, iat: now, exp: now + 120 }), opts());
    assert.equal(seen.get(jti), (now + 180) * 1000);
  });

  it("refuses other algorithms and junk", async () => {
    assert.deepEqual(await verifyAssertion(makeToken({}, { header: { alg: "none" } }), opts()), { ok: false, reason: "bad_header" });
    assert.deepEqual(await verifyAssertion(makeToken({}, { header: { alg: "HS256" } }), opts()), { ok: false, reason: "bad_header" });
    assert.deepEqual(await verifyAssertion(makeToken({}, { header: { kid: undefined } }), opts()), { ok: false, reason: "bad_header" });
    for (const junk of [undefined, null, 42, "", "a.b", "a.b.c.d", "a.b!.c", "x".repeat(9000)]) {
      assert.equal((await verifyAssertion(junk, opts())).ok, false);
    }
    assert.deepEqual(await verifyAssertion(makeToken({ email: "not an email" }), opts()), { ok: false, reason: "bad_claims" });
    assert.deepEqual(await verifyAssertion(makeToken({ jti: undefined }), opts()), { ok: false, reason: "bad_claims" });
  });
});

describe("JWKS", () => {
  it("keeps only Ed25519 signing keys", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "jwk" });
    const keys = parseJwks({
      keys: [
        jwkOf(keyA.publicKey, "a"),
        { ...rsa, kid: "rsa" },
        { ...jwkOf(keyB.publicKey, "enc"), use: "enc" },
        { kty: "OKP", crv: "Ed25519", x: "AAAA", kid: "short" },
        "nope",
      ],
    });
    assert.deepEqual([...keys.keys()], ["a"]);
    assert.equal(parseJwks(null).size, 0);
  });

  it("keeps the keys it had when the manager is down", async () => {
    let up = true;
    const cache = createJwksCache({
      now: () => clock,
      fetchImpl: async (url, init) => {
        if (!up) throw new Error("connection refused");
        return fetch(url, init);
      },
    });
    assert.ok(await cache.key(identity.managerUrl, "a"));
    up = false;
    clock += 6 * 60_000;
    assert.ok(await cache.key(identity.managerUrl, "a"));
  });
});

describe("identity", () => {
  const file = JSON.stringify({
    managerUrl: "https://api.genie.example/",
    projectId: "p-1",
    instanceId: "i-1",
    publicOrigin: "https://box.example",
  });

  it("reads the manager's file", () => {
    assert.deepEqual(parseGenieIdentity(file, {}), {
      managerUrl: "https://api.genie.example",
      projectId: "p-1",
      instanceId: "i-1",
      publicOrigin: "https://box.example",
    });
  });

  it("lets env override field by field", () => {
    const id = parseGenieIdentity(file, { GENIE_MANAGER_URL: "http://127.0.0.1:9", GENIE_INSTANCE_ID: "i-2" });
    assert.equal(id?.managerUrl, "http://127.0.0.1:9");
    assert.equal(id?.instanceId, "i-2");
    assert.equal(id?.projectId, "p-1");
    assert.equal(
      parseGenieIdentity(null, { GENIE_MANAGER_URL: "https://m", GENIE_PROJECT_ID: "p", GENIE_INSTANCE_ID: "i" })?.projectId,
      "p",
    );
  });

  it("is not configured without all three, or with junk", () => {
    assert.equal(parseGenieIdentity(null, {}), null);
    assert.equal(parseGenieIdentity("{not json", {}), null);
    assert.equal(parseGenieIdentity(JSON.stringify({ managerUrl: "https://m", projectId: "p" }), {}), null);
    assert.equal(parseGenieIdentity(JSON.stringify({ managerUrl: "file:///etc", projectId: "p", instanceId: "i" }), {}), null);
  });

  it("builds the manager's start URL", () => {
    const id = parseGenieIdentity(file, {})!;
    const url = new URL(managerStartUrl(id, "n0nce", "https://box.example/admin/api/auth/genie/callback"));
    assert.equal(url.origin + url.pathname, "https://api.genie.example/auth/vps/start");
    assert.equal(url.searchParams.get("project"), "p-1");
    assert.equal(url.searchParams.get("instance"), "i-1");
    assert.equal(url.searchParams.get("nonce"), "n0nce");
    assert.equal(url.searchParams.get("return"), "https://box.example/admin/api/auth/genie/callback");
  });

  it("makes 32-byte b64url nonces", () => {
    const n = newNonce();
    assert.match(n, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(n, newNonce());
  });
});

describe("accountDecision", () => {
  const rows = [
    { email: "alice@example.com", enabled: true },
    { email: "bob@example.com", enabled: false },
  ];
  it("matches regardless of case and spaces", () => {
    assert.equal(accountDecision(rows, "ALICE@Example.COM"), "ok");
    assert.equal(accountDecision(rows, " alice@example.com "), "ok");
  });
  it("refuses a disabled account", () => {
    assert.equal(accountDecision(rows, "bob@example.com"), "disabled");
    assert.equal(accountDecision(rows, "Bob@Example.com"), "disabled");
  });
  it("refuses an email that isn't on the list", () => {
    assert.equal(accountDecision(rows, "carol@example.com"), "absent");
    assert.equal(accountDecision([], "alice@example.com"), "absent");
    assert.equal(accountDecision(rows, "alice@example.co"), "absent");
  });
});

describe("sessions carry the person", () => {
  it("a Sign in with Genie session is user:<email>, the password one admin", async () => {
    const user = await readSessionToken(await createSessionToken(60, userSubject("alice@example.com")));
    assert.equal(user?.sub, "user:alice@example.com");
    assert.equal(sessionEmail(user?.sub), "alice@example.com");
    const admin = await readSessionToken(await createSessionToken(60));
    assert.equal(admin?.sub, "admin");
    assert.equal(sessionEmail(admin?.sub), null);
  });

  it("both kinds verify (requireAdmin / assertAdmin / isAdminRequest accept either): a Genie one only while its person is on the Users list", async () => {
    // (a Genie session reads fine, but verifies only for an enabled admin_users row: session-access.mjs, its own tests)
    assert.equal((await readSessionToken(await createSessionToken(60, userSubject("a@b.co"))))?.sub, "user:a@b.co");
    assert.equal(await verifySessionToken(await createSessionToken(60, userSubject("nobody-here@example.invalid"))), false);
    assert.equal(await verifySessionToken(await createSessionToken(60)), true);
    assert.equal(await verifySessionToken(await createSessionToken(-1, userSubject("a@b.co"))), false);
  });

  it("a changed subject breaks the signature", async () => {
    const [, sig] = (await createSessionToken(60, userSubject("a@b.co"))).split(".");
    const body = Buffer.from(JSON.stringify({ sub: "user:boss@b.co", exp: Date.now() + 60_000 })).toString("base64url");
    assert.equal(await readSessionToken(`${body}.${sig}`), null);
    assert.equal(await readSessionToken("x.!!"), null);
  });
});
