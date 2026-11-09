import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { authEnv, cleanToken, normalizeRemoteUrl, redactUrl, tokenHint, tokenInUrl } from "./git-auth-core";

describe("normalizeRemoteUrl", () => {
  it("takes owner/repo, ssh and https forms", () => {
    assert.equal(normalizeRemoteUrl("paulbrie/genie-local"), "https://github.com/paulbrie/genie-local.git");
    assert.equal(normalizeRemoteUrl("git@github.com:paulbrie/genie-local.git"), "https://github.com/paulbrie/genie-local.git");
    assert.equal(normalizeRemoteUrl("https://github.com/paulbrie/genie-local"), "https://github.com/paulbrie/genie-local.git");
    assert.equal(normalizeRemoteUrl(" https://github.com/paulbrie/genie-local.git/ "), "https://github.com/paulbrie/genie-local.git");
  });
  it("drops credentials typed into the URL", () => {
    assert.equal(normalizeRemoteUrl("https://me:ghp_secret@github.com/o/r.git"), "https://github.com/o/r.git");
  });
  it("refuses what isn't a repo over https", () => {
    assert.throws(() => normalizeRemoteUrl("http://github.com/o/r"));
    assert.throws(() => normalizeRemoteUrl("https://github.com/"));
    assert.throws(() => normalizeRemoteUrl("file:///etc/passwd"));
    assert.throws(() => normalizeRemoteUrl("ext::sh -c touch /tmp/x"));
    assert.throws(() => normalizeRemoteUrl(""));
  });
});

describe("tokens", () => {
  it("sends the token as a basic auth header for the remote's host only", () => {
    const env = authEnv("https://github.com/o/r.git", "ghp_abc");
    assert.equal(env.GIT_CONFIG_COUNT, "1");
    assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
    assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from("x-access-token:ghp_abc").toString("base64")}`);
  });
  it("finds a GitHub token written into a URL", () => {
    const fine = "github_pat_" + "A".repeat(82);
    assert.equal(tokenInUrl(`https://${fine}@github.com/o/r.git`), fine);
    assert.equal(tokenInUrl(`https://me:ghp_${"b".repeat(36)}@github.com/o/r.git`), `ghp_${"b".repeat(36)}`);
    assert.equal(tokenInUrl("https://github.com/o/r.git"), null);
    assert.equal(tokenInUrl("https://alice@github.com/o/r.git"), null);
    assert.equal(tokenInUrl("git@github.com:o/r.git"), null);
  });
  it("cleans and hints", () => {
    assert.equal(cleanToken("  ghp_abcd1234 \n"), "ghp_abcd1234");
    assert.throws(() => cleanToken("ghp abc"));
    assert.equal(tokenHint("ghp_abcd1234"), "1234");
    assert.equal(redactUrl("https://u:p@github.com/o/r.git"), "https://***@github.com/o/r.git");
  });
});
