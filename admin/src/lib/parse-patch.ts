/**
 * Split a raw `git show` / `git diff` patch into per-file entries shaped for
 * @git-diff-view's `data` prop. Pure and client-safe (no Node APIs), so it can
 * run in the browser on the patch text the /api/git/diff route returns.
 */

export type ParsedFile = {
  oldName: string | null;
  newName: string | null;
  /** lowlight language guess from the extension, or undefined. */
  lang?: string;
  /** Each entry is one `@@ … @@` hunk (header line included). */
  hunks: string[];
  binary: boolean;
};

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  scss: "scss",
  html: "xml",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  sh: "bash",
  bash: "bash",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
  toml: "ini",
};

function langOf(name: string | null): string | undefined {
  if (!name) return undefined;
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return EXT_LANG[ext];
}

/** "a/src/x.ts" → "src/x.ts"; "/dev/null" → null. */
function stripPrefix(p: string): string | null {
  if (p === "/dev/null") return null;
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

export function parsePatch(patch: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  // Each file section begins at a "diff --git " line.
  const sections = patch.split(/\n(?=diff --git )/);
  for (const section of sections) {
    if (!section.startsWith("diff --git ")) continue;
    const lines = section.split("\n");

    let oldName: string | null = null;
    let newName: string | null = null;
    let binary = false;
    const hunks: string[] = [];

    // Fallback names from the "diff --git a/X b/Y" line.
    const gitLine = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0]);
    if (gitLine) {
      oldName = gitLine[1];
      newName = gitLine[2];
    }

    // Parse the file header (everything before the first "@@") for names, then
    // assemble hunks. Once inside hunk content a "@@" only starts a new hunk, so
    // it can't be mistaken for a header line.
    let buf: string[] | null = null;
    for (const line of lines) {
      if (line.startsWith("@@")) {
        if (buf) hunks.push(buf.join("\n"));
        buf = [line];
        continue;
      }
      if (buf) {
        buf.push(line);
        continue;
      }
      if (line.startsWith("--- ")) oldName = stripPrefix(line.slice(4).trim());
      else if (line.startsWith("+++ "))
        newName = stripPrefix(line.slice(4).trim());
      else if (line.startsWith("Binary files ")) binary = true;
    }
    if (buf) hunks.push(buf.join("\n"));

    files.push({
      oldName,
      newName,
      lang: langOf(newName) ?? langOf(oldName),
      hunks,
      binary: binary && hunks.length === 0,
    });
  }
  return files;
}
