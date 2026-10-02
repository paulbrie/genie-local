"use client";

import { useRef, useState, useTransition } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileCode,
  Plus,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import {
  createDiagramAction,
  deleteDiagramAction,
  purgeDiagramAction,
  renameDiagramAction,
  restoreDiagramAction,
  updateDiagramAction,
} from "@/app/actions";
import { MermaidEditor } from "@/components/diagrams/mermaid-editor";
import { MermaidView } from "@/components/diagrams/mermaid-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Diagram } from "@/lib/diagrams";
import { cn } from "@/lib/utils";

const STARTER = `graph TD
  A[Start] --> B{Decision}
  B -->|yes| C[Do a thing]
  B -->|no| D[Do another]`;

type Draft = { title: string; source: string };

export function DiagramManager({
  initial,
  initialArchived,
}: {
  initial: Diagram[];
  initialArchived: Diagram[];
}) {
  const [items, setItems] = useState<Diagram[]>(initial);
  const [archived, setArchived] = useState<Diagram[]>(initialArchived);
  // null id = an unsaved new diagram being drafted.
  const [selectedId, setSelectedId] = useState<number | null>(
    initial[0]?.id ?? null,
  );
  const [draft, setDraft] = useState<Draft>(
    initial[0]
      ? { title: initial[0].title, source: initial[0].source }
      : { title: "Untitled diagram", source: STARTER },
  );
  // Id of the list row currently being renamed inline, plus its edit buffer.
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameText, setRenameText] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [, startTransition] = useTransition();
  const svgRef = useRef<string>("");

  const select = (d: Diagram) => {
    setSelectedId(d.id);
    setDraft({ title: d.title, source: d.source });
  };

  const newDraft = () => {
    setSelectedId(null);
    setDraft({ title: "Untitled diagram", source: STARTER });
  };

  const save = () => {
    const title = draft.title.trim();
    if (!title) return toast.error("Give the diagram a title");
    if (!draft.source.trim()) return toast.error("The diagram is empty");
    startTransition(async () => {
      try {
        if (selectedId === null) {
          const id = await createDiagramAction({ title, source: draft.source });
          const now = new Date();
          setItems((prev) => [
            {
              id,
              title,
              source: draft.source,
              format: "mermaid",
              archivedAt: null,
              createdAt: now,
              updatedAt: now,
            },
            ...prev,
          ]);
          setSelectedId(id);
          toast.success("Diagram created");
        } else {
          await updateDiagramAction(selectedId, {
            title,
            source: draft.source,
          });
          setItems((prev) =>
            prev.map((d) =>
              d.id === selectedId ? { ...d, title, source: draft.source } : d,
            ),
          );
          toast.success("Diagram saved");
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Save failed");
      }
    });
  };

  const startRename = (d: Diagram) => {
    setRenamingId(d.id);
    setRenameText(d.title);
  };

  const commitRename = (d: Diagram) => {
    const title = renameText.trim();
    setRenamingId(null);
    if (!title || title === d.title) return;
    startTransition(async () => {
      try {
        await renameDiagramAction(d.id, title);
        setItems((prev) =>
          prev.map((x) => (x.id === d.id ? { ...x, title } : x)),
        );
        if (selectedId === d.id) setDraft((dr) => ({ ...dr, title }));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Rename failed");
      }
    });
  };

  // Soft-delete: archive + offer an inline Undo before it's out of sight.
  const archive = (d: Diagram) => {
    startTransition(async () => {
      try {
        await deleteDiagramAction(d.id);
        setItems((prev) => prev.filter((x) => x.id !== d.id));
        setArchived((prev) => [{ ...d, archivedAt: new Date() }, ...prev]);
        if (selectedId === d.id) newDraft();
        toast.success(`Archived “${d.title}”`, {
          action: { label: "Undo", onClick: () => restore(d) },
        });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Archive failed");
      }
    });
  };

  const restore = (d: Diagram) => {
    startTransition(async () => {
      try {
        await restoreDiagramAction(d.id);
        setArchived((prev) => prev.filter((x) => x.id !== d.id));
        setItems((prev) => [{ ...d, archivedAt: null }, ...prev]);
        toast.success(`Restored “${d.title}”`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Restore failed");
      }
    });
  };

  const purge = (d: Diagram) => {
    if (!confirm(`Permanently delete “${d.title}”? This cannot be undone.`))
      return;
    startTransition(async () => {
      try {
        await purgeDiagramAction(d.id);
        setArchived((prev) => prev.filter((x) => x.id !== d.id));
        toast.success("Deleted permanently");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Delete failed");
      }
    });
  };

  const copySource = async () => {
    await navigator.clipboard.writeText(draft.source);
    toast.success("Source copied");
  };

  const downloadSvg = () => {
    if (!svgRef.current) return toast.error("Nothing rendered yet");
    const blob = new Blob([svgRef.current], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(draft.title || "diagram").replace(/[^\w.-]+/g, "-")}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      {/* Saved-diagram list */}
      <aside className="flex flex-col gap-2">
        <Button size="sm" onClick={newDraft} className="justify-start">
          <Plus /> New diagram
        </Button>
        <ul className="flex flex-col gap-0.5">
          {items.map((d) => (
            <li key={d.id}>
              {renamingId === d.id ? (
                <Input
                  autoFocus
                  value={renameText}
                  onChange={(e) => setRenameText(e.target.value)}
                  onBlur={() => commitRename(d)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(d);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  className="h-8 text-sm"
                />
              ) : (
                <button
                  onClick={() => select(d)}
                  onDoubleClick={() => startRename(d)}
                  title="Double-click to rename"
                  className={cn(
                    "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                    d.id === selectedId
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50",
                  )}
                >
                  <FileCode className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{d.title}</span>
                  <Trash2
                    role="button"
                    aria-label="Archive"
                    onClick={(e) => {
                      e.stopPropagation();
                      archive(d);
                    }}
                    className="size-3.5 shrink-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                  />
                </button>
              )}
            </li>
          ))}
          {items.length === 0 && (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">
              No diagrams yet.
            </li>
          )}
        </ul>

        {/* Archived (soft-deleted) diagrams */}
        {archived.length > 0 && (
          <div className="mt-1 border-t pt-2">
            <button
              onClick={() => setShowArchived((s) => !s)}
              className="flex w-full items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {showArchived ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              Archived ({archived.length})
            </button>
            {showArchived && (
              <ul className="flex flex-col gap-0.5">
                {archived.map((d) => (
                  <li
                    key={d.id}
                    className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
                  >
                    <span className="flex-1 truncate text-muted-foreground">
                      {d.title}
                    </span>
                    <RotateCcw
                      role="button"
                      aria-label="Restore"
                      onClick={() => restore(d)}
                      className="size-3.5 shrink-0 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                    />
                    <Trash2
                      role="button"
                      aria-label="Delete permanently"
                      onClick={() => purge(d)}
                      className="size-3.5 shrink-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </aside>

      {/* Editor + live preview */}
      <section className="grid min-h-[32rem] grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="flex min-h-0 flex-col gap-2">
          <div className="flex items-center gap-2">
            <Input
              value={draft.title}
              onChange={(e) =>
                setDraft((d) => ({ ...d, title: e.target.value }))
              }
              placeholder="Diagram title"
              className="flex-1"
            />
            <Button size="sm" onClick={save}>
              <Save /> Save
            </Button>
          </div>
          <div className="min-h-[24rem] flex-1 overflow-hidden">
            <MermaidEditor
              value={draft.source}
              onChange={(v) => setDraft((d) => ({ ...d, source: v }))}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button size="xs" variant="ghost" onClick={copySource}>
              <Copy /> Copy source
            </Button>
            <Button size="xs" variant="ghost" onClick={downloadSvg}>
              <Download /> Export SVG
            </Button>
          </div>
        </div>
        <div className="min-h-[24rem] rounded-lg border bg-card">
          <MermaidView
            source={draft.source}
            onRendered={(svg) => {
              svgRef.current = svg;
            }}
          />
        </div>
      </section>
    </div>
  );
}
