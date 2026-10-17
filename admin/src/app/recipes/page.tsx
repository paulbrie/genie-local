import { RecipesManager } from "@/components/recipes-manager";
import { listRecipes } from "@/lib/project-recipes";

export const dynamic = "force-dynamic";

/** /recipes: reusable prompts for kinds of projects. */
export default async function RecipesPage() {
  const recipes = await listRecipes();
  return (
    <main className="mx-auto w-full max-w-7xl flex-1 space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Recipes</h1>
        <p className="text-sm text-muted-foreground">
          Prompts for kinds of projects, saved to reuse: copy one into a terminal, or ask any Claude
          session to start from it (the local-genie MCP reads them).
        </p>
      </header>
      <RecipesManager recipes={recipes} />
    </main>
  );
}
