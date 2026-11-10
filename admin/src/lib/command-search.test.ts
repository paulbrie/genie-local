import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isPaletteShortcut, rankCommands, type Command } from "./command-search";

const items: Command[] = [
  { id: "p:/", kind: "page", label: "Dashboard" },
  { id: "p:/terminals", kind: "page", label: "Terminals" },
  { id: "p:/browsers", kind: "page", label: "Browsers", keywords: "chrome extension computers" },
  { id: "pr:acccess", kind: "project", label: "acccess", keywords: "project" },
  { id: "pr:acccess-content", kind: "project", label: "acccess-content", keywords: "project" },
  { id: "t:acccess:vercel", kind: "tab", label: "acccess › Vercel", keywords: "acccess vercel" },
  { id: "t:acccess:git", kind: "tab", label: "acccess › Git", keywords: "acccess git" },
  { id: "term:Alice", kind: "terminal", label: "Alice", detail: "working" },
  { id: "a:theme", kind: "action", label: "Switch to dark theme", keywords: "theme mode" },
];
const ids = (q: string) => rankCommands(items, q).map((i) => i.id);

describe("command palette search", () => {
  it("keeps everything, in order, for an empty query", () => {
    assert.deepEqual(ids(""), items.map((i) => i.id));
  });
  it("needs every word to match, best at a word's start", () => {
    assert.deepEqual(ids("acc ver"), ["t:acccess:vercel"]);
    assert.deepEqual(ids("term"), ["p:/terminals"]);
    assert.deepEqual(ids("chrome"), ["p:/browsers"]);
    assert.deepEqual(ids("nothing like it"), []);
  });
  it("puts an exact name first, then projects before their tabs", () => {
    const r = ids("acccess");
    assert.equal(r[0], "pr:acccess");
    assert.ok(r.indexOf("pr:acccess-content") < r.indexOf("t:acccess:vercel"));
  });
  it("finds terminals by status and actions by keyword", () => {
    assert.deepEqual(ids("working"), ["term:Alice"]);
    assert.deepEqual(ids("dark"), ["a:theme"]);
  });
});

describe("the shortcut", () => {
  const key = (o: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({ key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
  const nowhere = { inEditor: false, inTerminal: false };
  it("is ⌘K or Ctrl+K, nothing else", () => {
    assert.equal(isPaletteShortcut(key({ metaKey: true }), nowhere), true);
    assert.equal(isPaletteShortcut(key({ ctrlKey: true }), nowhere), true);
    assert.equal(isPaletteShortcut(key({ key: "K", ctrlKey: true }), nowhere), true);
    assert.equal(isPaletteShortcut(key({}), nowhere), false);
    assert.equal(isPaletteShortcut(key({ ctrlKey: true, shiftKey: true }), nowhere), false);
    assert.equal(isPaletteShortcut(key({ key: "j", ctrlKey: true }), nowhere), false);
  });
  it("leaves code editors their chords, and the shell its Ctrl+K", () => {
    assert.equal(isPaletteShortcut(key({ metaKey: true }), { inEditor: true, inTerminal: false }), false);
    assert.equal(isPaletteShortcut(key({ ctrlKey: true }), { inEditor: false, inTerminal: true }), false);
    assert.equal(isPaletteShortcut(key({ metaKey: true }), { inEditor: false, inTerminal: true }), true);
  });
});
