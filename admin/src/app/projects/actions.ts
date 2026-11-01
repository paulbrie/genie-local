"use server";

import fs from "node:fs/promises";
import path from "node:path";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getArchivedSlugs } from "@/lib/data";
import { listRecipes } from "@/lib/project-recipes";
import { requireAdmin } from "@/lib/require-admin";
import { rescanProject } from "@/lib/scan";
import { PROJECTS_ROOT } from "@/lib/signals";
import { startAgent } from "@/lib/task-delegate";
import { listTerminals } from "@/lib/terminals";

export type RecipeChoice = { id: number; name: string; kind: string | null; description: string | null };

/** The recipes the New project modal offers (no bodies: they can be long). */
export async function recipeChoicesAction(): Promise<RecipeChoice[]> {
  await requireAdmin();
  return (await listRecipes()).map(({ id, name, kind, description }) => ({ id, name, kind, description }));
}

const Slug = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,40}$/, "Use lowercase letters, digits and dashes (up to 41), starting with a letter or digit");

/** The new Claude's first prompt: where it is, then the recipe. */
const recipeBrief = (slug: string, dir: string, recipe: { name: string; body: string }) =>
  `This is a new project, "${slug}", in ${dir} (your working directory, an empty folder). ` +
  `Build it from the recipe "${recipe.name}" below.\n\n${recipe.body}`;

/**
 * New project: a folder `<PROJECTS_ROOT>/<name>`, registered at once so it's in
 * the sidebar. With a recipe, a Claude terminal named after the project starts
 * in it with the recipe as its first prompt (as a new agent for a ticket does).
 * Errors come back as values: in production a thrown action error is redacted.
 */
export async function createProjectAction(
  name: string,
  recipeId: number | null,
): Promise<{ ok: true; slug: string; terminal: string | null } | { ok: false; error: string }> {
  await requireAdmin();
  const parsed = Slug.safeParse(name);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const slug = parsed.data;

  if ((await getArchivedSlugs()).has(slug)) {
    return { ok: false, error: `An archived project is named "${slug}": restore it from Projects, or pick another name` };
  }
  const recipe = recipeId == null ? null : (await listRecipes()).find((r) => r.id === recipeId);
  if (recipe === undefined) return { ok: false, error: "That recipe no longer exists" };
  if (recipe && (await listTerminals()).some((t) => t.name === slug)) {
    return { ok: false, error: `A terminal "${slug}" already exists: close it, or pick another name` };
  }

  const dir = path.join(path.resolve(PROJECTS_ROOT), slug);
  try {
    await fs.mkdir(dir); // not recursive: never adopts an existing folder
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, error: code === "EEXIST" ? `A folder "${slug}" already exists in ${PROJECTS_ROOT}` : String(err) };
  }

  if (recipe) {
    try {
      await startAgent(slug, dir, recipeBrief(slug, dir, recipe));
    } catch (err) {
      await fs.rmdir(dir).catch(() => {}); // still empty: leave nothing behind
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  await rescanProject(slug);
  revalidatePath("/projects");
  return { ok: true, slug, terminal: recipe ? slug : null };
}
