import "server-only";

import { asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { projectRecipes } from "@/db/schema";

export async function listRecipes() {
  return db.select().from(projectRecipes).orderBy(asc(projectRecipes.kind), asc(projectRecipes.name));
}

export type RecipeFields = {
  name: string;
  kind: string | null;
  description: string | null;
  body: string;
};

/** Create (no id) or update a recipe; returns its id. */
export async function saveRecipe(id: number | null, fields: RecipeFields): Promise<number> {
  if (id == null) {
    const [row] = await db.insert(projectRecipes).values(fields).returning({ id: projectRecipes.id });
    return row.id;
  }
  const [row] = await db
    .update(projectRecipes)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(projectRecipes.id, id))
    .returning({ id: projectRecipes.id });
  if (!row) throw new Error(`No recipe ${id}`);
  return row.id;
}

export async function deleteRecipe(id: number) {
  await db.delete(projectRecipes).where(eq(projectRecipes.id, id));
}
