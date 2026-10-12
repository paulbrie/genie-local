import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

// (the map's layers are drawn in their order in IsoCity's JSX: read from the source, as there is no DOM here)
const src = readFileSync(resolve(process.cwd(), "src/components/agents3d/ops/ops-view.tsx"), "utf8");

describe("the map's layers (T205e, T205f)", () => {
  it("draws the bubbles last: their svg is the map layer's last child, after every connector and sprite", () => {
    const layer = src.indexOf("<div ref={layer}"), bubbles = src.indexOf("<Bubbles "), end = src.indexOf("</div>", bubbles);
    assert.ok(layer > 0 && bubbles > layer, "the bubbles are in the map layer");
    const svg = src.lastIndexOf("<svg", bubbles);
    assert.ok(svg > layer && !/<(?:[A-Z]\w*|path|g|circle|canvas|svg|div)\b/.test(src.slice(svg + 4, bubbles).replace(/^[^>]*>/, "")), "the bubbles have an svg of their own");
    assert.match(src.slice(bubbles, end), /^<Bubbles [^\n]*\/>\s*<\/svg>\s*$/, "nothing after them in the map layer");
    for (const c of ["<Curve ", "<ManagerLink ", "<Desk ", "<Belts ", "<ServerRack ", "<canvas ref={litC}"]) {
      const at = src.indexOf(c);
      assert.ok(at > layer && at < svg, `${c.trim()} under the bubbles`);
    }
  });
});
