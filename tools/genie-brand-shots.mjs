// Screenshots the genie-brand pages (light + dark) and reports console errors.
// node genie-brand-shots.mjs [out-dir] [base-url, default http://localhost:3016/projects/genie-brand]
import { chromium } from "playwright-core";

const out = process.argv[2] ?? "/tmp/gb";
const base = process.argv[3] ?? "http://localhost:3016/projects/genie-brand";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  page.on("console", m => m.type() === "error" && console.log(`[${scheme} console]`, m.text().slice(0, 300)));
  page.on("pageerror", e => console.log(`[${scheme} pageerror]`, e.message));
  for (const path of ["/v1", "/v1/research"]) {
    await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
    await page.screenshot({ path: `${out}/${scheme}${path.replaceAll("/", "_")}.png`, fullPage: true });
  }
  if (scheme === "light") {
    // the surface toggle (subjecto store) flips every preview; the swatch copies its hex
    await page.goto(`${base}/v1`, { waitUntil: "networkidle" });
    await page.getByRole("radio", { name: "night" }).first().click();
    const grounds = await page.locator("#formats .rounded-lg.border").evaluateAll(els => els.map(e => getComputedStyle(e).backgroundColor));
    console.log("format grounds after night:", [...new Set(grounds)].join(" | "));
    await page.getByRole("button", { name: /Deep wish/ }).click();
    console.log("clipboard:", await page.evaluate(() => navigator.clipboard.readText()));
    await page.locator("#the-logo").screenshot({ path: `${out}/night_logo.png` });
  }
  await ctx.close();
}
await browser.close();
