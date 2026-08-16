# /opt/project/tools

Server-wide tooling for verifying any project under `/opt/project` — not tied to
one app. Persistent (survives reboots), unlike anything left in `/tmp`.

## Headless browser (Playwright + Chromium)

Use it to check things `curl` can't: client hydration, JS console/network
errors, cross-origin `_next/*` failures, and login/redirect flows.

- Package: `playwright-core` (installed here, in `node_modules/`).
- Chromium binaries: `~/.cache/ms-playwright/` (shared, persistent).

Run a script from this directory (so `playwright-core` resolves):

```js
// /opt/project/tools/example.mjs   →   node example.mjs
import { chromium } from "playwright-core";

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();

page.on("console", (m) => m.type() === "error" && console.log("[console]", m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto("https://ft.cloud.teleporthq.ai/admin", { waitUntil: "networkidle" });
// Admin app is behind auth: log in via the form, or set the `admin_session`
// cookie on `ctx` before navigating.
console.log(page.url(), await page.title());

await browser.close();
```

Reinstall (only if `node_modules` is missing): `cd /opt/project/tools && npm install`.
