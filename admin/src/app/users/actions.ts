"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { addUser, removeUser, setUserEnabled } from "@/lib/admin-users";
import { isEmail, normalizeEmail } from "@/lib/genie-sso-core";
import { requireAdmin } from "@/lib/require-admin";

const Fields = z.object({
  email: z
    .string()
    .transform(normalizeEmail)
    .refine(isEmail, "That isn't an email address"),
  name: z.string().trim().min(1, "Give the person's name").max(120),
});

const Id = z.number().int().positive();

/** Errors come back as values: in production a thrown action error reaches the client redacted. */
type Result = { ok: true } | { ok: false; error: string };

export async function addUserAction(fields: { email: string; name: string }): Promise<Result> {
  await requireAdmin();
  const parsed = Fields.safeParse(fields);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid user" };
  try {
    await addUser(parsed.data.email, parsed.data.name);
  } catch (err) {
    // drizzle wraps the Postgres error; 23505 = unique_violation (the email).
    const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code ?? (err as { code?: string })?.code;
    if (code === "23505") return { ok: false, error: `${parsed.data.email} is already on the list` };
    console.error("[users] add failed:", err);
    return { ok: false, error: "Couldn't add the user (see the server log)" };
  }
  revalidatePath("/users");
  return { ok: true };
}

export async function setUserEnabledAction(id: number, enabled: boolean): Promise<void> {
  await requireAdmin();
  await setUserEnabled(Id.parse(id), z.boolean().parse(enabled));
  revalidatePath("/users");
}

export async function removeUserAction(id: number): Promise<void> {
  await requireAdmin();
  await removeUser(Id.parse(id));
  revalidatePath("/users");
}
