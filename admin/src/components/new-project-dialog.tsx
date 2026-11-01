"use client";

import { FolderPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { createProjectAction, recipeChoicesAction, type RecipeChoice } from "@/app/projects/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { openTerminal } from "@/store/terminals";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

/**
 * New project (right-click on Projects in the sidebar): every recipe, grouped
 * by kind, or an empty folder, and the project's name. Creating it opens the
 * project, and the Claude terminal building it from the recipe.
 */
export function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const router = useRouter();
  const [recipes, setRecipes] = useState<RecipeChoice[] | null>(null);
  const [failed, setFailed] = useState(false);
  // null = empty folder
  const [picked, setPicked] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    recipeChoicesAction().then(
      (list) => {
        setRecipes(list);
        if (list.length > 0) setPicked(list[0].id);
      },
      () => setFailed(true),
    );
  }, []);

  const groups = new Map<string, RecipeChoice[]>();
  for (const r of recipes ?? []) {
    const k = r.kind ?? "Other";
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }

  const slug = name.trim();
  const valid = SLUG_RE.test(slug);

  async function create() {
    if (!valid || busy) return;
    setBusy(true);
    const res = await createProjectAction(slug, picked).catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    }));
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(res.terminal ? `${res.slug} created: Claude is building it` : `${res.slug} created`);
    if (res.terminal) openTerminal(res.terminal);
    onCreated();
    onClose();
    router.push(`/projects/${encodeURIComponent(res.slug)}`);
  }

  const option = (id: number | null, title: string, description: string | null) => (
    <button
      key={id ?? "empty"}
      type="button"
      role="radio"
      aria-checked={picked === id}
      onClick={() => setPicked(id)}
      className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
        picked === id ? "border-primary bg-accent" : "border-transparent hover:bg-accent/50"
      }`}
    >
      <div className="text-sm font-medium">{title}</div>
      {description && <div className="text-xs text-muted-foreground">{description}</div>}
    </button>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderPlus className="size-4" /> New project
          </DialogTitle>
          <DialogDescription>
            A new folder in the projects folder. With a recipe, a Claude terminal named after the project builds it.
          </DialogDescription>
        </DialogHeader>

        <form
          id="new-project"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="new-project-name">Name</Label>
            <Input
              id="new-project-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="my-project"
              className="font-mono"
              aria-invalid={slug !== "" && !valid}
            />
            {slug !== "" && !valid && (
              <p className="text-xs text-destructive">Lowercase letters, digits and dashes, starting with a letter or digit.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Recipe</Label>
            <div role="radiogroup" className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
              {failed && <p className="text-xs text-destructive">Couldn&apos;t load the recipes.</p>}
              {!recipes && !failed && <p className="text-xs text-muted-foreground">Loading recipes…</p>}
              {[...groups].map(([kind, list]) => (
                <div key={kind} className="space-y-1">
                  <div className="px-1 text-xs font-medium text-muted-foreground">{kind}</div>
                  {list.map((r) => option(r.id, r.name, r.description))}
                </div>
              ))}
              {recipes && (
                <div className="space-y-1">
                  <div className="px-1 text-xs font-medium text-muted-foreground">No recipe</div>
                  {option(null, "Empty folder", "Just the folder; no Claude terminal.")}
                </div>
              )}
            </div>
          </div>
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="new-project" disabled={!valid || busy}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
