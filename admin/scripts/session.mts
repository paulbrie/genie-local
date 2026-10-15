// Mints an admin_session cookie value for testing the admin app from scripts
// and headless browsers (curl, Playwright) without going through the login form.
//
//   npm run -s session            -> token valid for 1 hour
//   npm run -s session -- 15m     -> custom lifetime (s / m / h / d)
//
// Prints only the token on stdout. Use it as the `admin_session` cookie:
//   curl -b "admin_session=$(npm run -s session)" http://127.0.0.1:3002/admin
//
// Signs with APP_ENC_KEY from .env.local, read explicitly so a stale value
// exported in the shell can't produce a token the server rejects.

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

import { createSessionToken, SESSION_COOKIE } from "../src/lib/session";

const envFile = path.join(import.meta.dirname, "..", ".env.local");
const key = parseEnv(readFileSync(envFile, "utf8")).APP_ENC_KEY;
if (!key) {
  console.error(`APP_ENC_KEY is missing from ${envFile}`);
  process.exit(1);
}
process.env.APP_ENC_KEY = key;

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
const arg = process.argv[2] ?? "1h";
const m = /^(\d+)([smhd])$/.exec(arg);
if (!m) {
  console.error(`Bad lifetime "${arg}"; use e.g. 30m, 2h, 1d`);
  process.exit(1);
}
const ttl = Number(m[1]) * UNITS[m[2]];

console.log(await createSessionToken(ttl));
console.error(`${SESSION_COOKIE} token, valid for ${arg}`);
