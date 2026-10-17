"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { deleteRecipe, saveRecipe } from "@/lib/project-recipes";
import { requireAdmin } from "@/lib/require-admin";

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => s || null)
    .nullable();

const Fields = z.object({
  name: z.string().trim().min(1, "Give the recipe a name").max(120),
  kind: optional(80),
  description: optional(300),
  body: z.string().trim().min(1, "The prompt is empty").max(100_000),
});

/** Errors come back as values: in production a thrown action error reaches the client redacted. */
type Result = { ok: true; id: number } | { ok: false; error: string };

export async function saveRecipeAction(
  id: number | null,
  fields: { name: string; kind: string | null; description: string | null; body: string },
): Promise<Result> {
  await requireAdmin();
  const parsed = Fields.safeParse(fields);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid recipe" };
  try {
    const savedId = await saveRecipe(id == null ? null : z.number().int().positive().parse(id), parsed.data);
    revalidatePath("/recipes");
    return { ok: true, id: savedId };
  } catch (err) {
    // drizzle wraps the Postgres error; 23505 = unique_violation (the name).
    const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code ?? (err as { code?: string })?.code;
    if (code === "23505") return { ok: false, error: `A recipe named "${parsed.data.name}" already exists` };
    console.error("[recipes] save failed:", err);
    return { ok: false, error: "Couldn't save the recipe (see the server log)" };
  }
}

export async function deleteRecipeAction(id: number): Promise<void> {
  await requireAdmin();
  await deleteRecipe(z.number().int().positive().parse(id));
  revalidatePath("/recipes");
}
