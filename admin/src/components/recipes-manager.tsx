"use client";

import { Copy, CopyPlus, Plus, Save, Search, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { deleteRecipeAction, saveRecipeAction } from "@/app/recipes/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ProjectRecipe } from "@/db/schema";
import { formatRelativeTime } from "@/lib/format";

type Draft = { name: string; kind: string; description: string; body: string };
const EMPTY: Draft = { name: "", kind: "", description: "", body: "" };

const toDraft = (r: ProjectRecipe): Draft => ({
  name: r.name,
  kind: r.kind ?? "",
  description: r.description ?? "",
  body: r.body,
});

/**
 * The Recipes page: the saved recipes (grouped by kind, searchable) and an
 * editor for the selected one, or a new one. ?id=<n> selects a recipe.
 */
export function RecipesManager({ recipes }: { recipes: ProjectRecipe[] }) {
  const router = useRouter();
  const params = useSearchParams();

  // Which recipe is open ("new" = unsaved), its draft and the last saved version
  // of it: kept here and set by each action, so the editor never resets while
  // the URL (which only mirrors the selection, for links) catches up.
  const [current, setCurrent] = useState<number | "new">(() => {
    const p = params.get("id");
    if (p === "new") return "new";
    const id = Number(p);
    return recipes.some((r) => r.id === id) ? id : (recipes[0]?.id ?? "new");
  });
  const initial = current === "new" ? null : recipes.find((r) => r.id === current);
  const [draft, setDraft] = useState<Draft>(initial ? toDraft(initial) : EMPTY);
  const [baseline, setBaseline] = useState<Draft>(initial ? toDraft(initial) : EMPTY);
  const isNew = current === "new";
  const selected = isNew ? null : (recipes.find((r) => r.id === current) ?? null);
  const dirty = (Object.keys(draft) as (keyof Draft)[]).some((k) => draft[k] !== baseline[k]);
  const showUrl = (id: number | "new" | null) =>
    router.replace(id == null ? "/recipes" : `/recipes?id=${id}`, { scroll: false });

  const [query, setQuery] = useState("");
  const [isPending, startTransition] = useTransition();

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = q
      ? recipes.filter((r) =>
          [r.name, r.kind, r.description, r.body].some((f) => f?.toLowerCase().includes(q)),
        )
      : recipes;
    const map = new Map<string, ProjectRecipe[]>();
    for (const r of shown) {
      const k = r.kind?.trim() || "Other";
      map.set(k, [...(map.get(k) ?? []), r]);
    }
    return [...map.entries()];
  }, [recipes, query]);
  const kinds = useMemo(
    () => [...new Set(recipes.map((r) => r.kind).filter((k): k is string => !!k))].sort(),
    [recipes],
  );

  function open(id: number | "new") {
    if (dirty && !window.confirm("Discard the unsaved changes to this recipe?")) return;
    const r = id === "new" ? null : recipes.find((x) => x.id === id);
    const d = r ? toDraft(r) : EMPTY;
    setCurrent(id);
    setDraft(d);
    setBaseline(d);
    showUrl(id);
  }

  function save() {
    const saving = draft;
    startTransition(async () => {
      const res = await saveRecipeAction(isNew ? null : current, {
        name: draft.name,
        kind: draft.kind || null,
        description: draft.description || null,
        body: draft.body,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Saved "${saving.name.trim()}"`);
      // What was saved is the new baseline (edits typed meanwhile stay unsaved).
      setBaseline(saving);
      if (isNew) {
        setCurrent(res.id);
        showUrl(res.id);
      }
    });
  }

  function remove() {
    if (!selected || !window.confirm(`Delete the recipe "${selected.name}"?`)) return;
    startTransition(async () => {
      await deleteRecipeAction(selected.id);
      toast.success(`Deleted "${selected.name}"`);
      const next = recipes.find((r) => r.id !== selected.id);
      const d = next ? toDraft(next) : EMPTY;
      setCurrent(next?.id ?? "new");
      setDraft(d);
      setBaseline(d);
      showUrl(next?.id ?? null);
    });
  }

  function duplicate() {
    setCurrent("new");
    setDraft({ ...draft, name: `${draft.name} (copy)` });
    setBaseline(EMPTY);
    showUrl("new");
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(draft.body);
      toast.success("Prompt copied");
    } catch {
      toast.error("The browser blocked the clipboard");
    }
  }

  // Ctrl/Cmd+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (dirty && !isPending) save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const lines = draft.body ? draft.body.split("\n").length : 0;

  return (
    <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
      {/* List */}
      <aside className="space-y-2">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search recipes…"
              aria-label="Search recipes"
              className="h-8 pl-7"
            />
          </div>
          <Button size="sm" onClick={() => open("new")} title="New recipe">
            <Plus className="size-4" />
            New
          </Button>
        </div>
        <nav aria-label="Recipes" className="max-h-[calc(100vh-14rem)] space-y-3 overflow-y-auto rounded-md border p-1">
          {recipes.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">No recipes yet. Write the first one →</p>
          ) : groups.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">No recipe matches “{query}”.</p>
          ) : (
            groups.map(([kind, list]) => (
              <div key={kind}>
                <div className="px-2 pt-1 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  {kind}
                </div>
                {list.map((r) => {
                  const on = !isNew && r.id === selected?.id;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => open(r.id)}
                      aria-current={on ? "true" : undefined}
                      className={`block w-full rounded-md px-2 py-1.5 text-left text-sm ${
                        on ? "bg-accent font-medium text-accent-foreground" : "hover:bg-accent/50"
                      }`}
                    >
                      <span className="block truncate">{r.name}</span>
                      {r.description && (
                        <span className="block truncate text-xs font-normal text-muted-foreground">{r.description}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </nav>
      </aside>

      {/* Editor */}
      <section className="space-y-3 rounded-md border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-sm font-medium">
            {isNew ? "New recipe" : (selected?.name ?? "")}
            {dirty && <span className="ml-2 text-xs font-normal text-amber-700 dark:text-amber-400">unsaved</span>}
            {!isNew && selected && !dirty && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                saved {formatRelativeTime(selected.updatedAt)}
              </span>
            )}
          </h2>
          <Button size="sm" variant="outline" onClick={copy} disabled={!draft.body}>
            <Copy className="size-4" />
            Copy prompt
          </Button>
          {!isNew && selected && (
            <>
              <Button size="sm" variant="outline" onClick={duplicate}>
                <CopyPlus className="size-4" />
                Duplicate
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={remove}
                disabled={isPending}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="size-4" />
                Delete
              </Button>
            </>
          )}
          <Button size="sm" onClick={save} disabled={!dirty || isPending} title="Save (Ctrl+S)">
            <Save className="size-4" />
            {isPending ? "Saving…" : "Save"}
          </Button>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Name, e.g. Next.js + Drizzle admin app"
            aria-label="Name"
          />
          <Input
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
            placeholder="Project type, e.g. Web app"
            aria-label="Project type"
            list="recipe-kinds"
          />
          <datalist id="recipe-kinds">
            {kinds.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
        </div>
        <Input
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="When to use it (one line)"
          aria-label="Description"
        />
        <Textarea
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          placeholder={"The prompt. E.g.\n\nCreate a Next.js app in /opt/project/projects/<name> with …\n- Drizzle + Postgres\n- shadcn/ui\n- …"}
          aria-label="Prompt"
          spellCheck={false}
          className="min-h-[50vh] resize-y font-mono text-xs leading-relaxed md:text-xs"
        />
        <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {lines} line{lines === 1 ? "" : "s"} · {draft.body.length.toLocaleString()} characters
          </span>
          {!isNew && selected && (
            <span>
              In any Claude session: <q className="font-mono">start from the “{selected.name}” recipe</q>
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
