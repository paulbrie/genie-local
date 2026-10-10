import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { asksUser } from "./asking";

describe("asksUser", () => {
  it("is true when the last paragraph asks something", () => {
    for (const t of [
      "Done: tests pass (61/61) and the build is clean.\n\nShould I push it to origin/main?",
      "I can fix it two ways:\n\n1. Keep the old field.\n2. Rename it.\n\nWhich do you prefer: 1 or 2?",
      "Want me to update the README too? I can do it in the same commit.",
      "The deploy is ready.\n\n**Shall I run it now?**",
      "どちらにしますか？",
      "Pushed b50cf4e.\n\nAnything else, or should I go on with T99? ",
    ])
      assert.equal(asksUser(t), true, t);
  });
  it("is false when the turn ends on a statement, even after a question", () => {
    for (const t of [
      "Done. The lint is no worse than origin's.",
      "What changed?\n\n- the parser\n- its tests\n\nAll pass.",
      "",
      "Should I push?\n\nNo: Alice commits. Waiting for her review.",
    ])
      assert.equal(asksUser(t), false, t);
  });
  it("leaves out question marks in code, quotes and links", () => {
    for (const t of [
      "Fixed the ternary:\n\n```ts\nconst x = ok ? a : b;\n```",
      "Use `ok ? a : b` there instead of the if.",
      'The dialog now reads "Save changes?" and the button is enabled.',
      "It said “Is the port in use?” before; now it starts.",
      "> Can you check the logs?\n>\n> (from Bob)",
      "Details: https://example.com/search?q=lift&page=2",
      "Here's the start of the script:\n\n```bash\nread -p 'Continue?' x",
    ])
      assert.equal(asksUser(t), false, t);
  });
});
