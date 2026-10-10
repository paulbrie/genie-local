/**
 * Hidden folders: a folder whose name starts with "." (.next, .git, .claude,
 * .turbo, src/.cache…). Agents City leaves them out of the cities unless asked
 * ("Show hidden folders"). A dot-file in a shown folder (.gitignore,
 * src/.eslintrc) stays: only what comes in through a hidden folder goes.
 */

/** Whether a repo-relative path ("a/b/c.ts") lies inside a hidden folder, at any depth. */
export function inHiddenDir(p: string): boolean {
  const parts = p.split("/");
  for (let i = 0; i < parts.length - 1; i++) if (parts[i].startsWith(".")) return true;
  return false;
}

/** `files` without those in hidden folders, unless `showHidden`. */
export function withoutHiddenDirs<T extends { p: string }>(files: T[], showHidden: boolean): T[] {
  return showHidden ? files : files.filter((f) => !inHiddenDir(f.p));
}
