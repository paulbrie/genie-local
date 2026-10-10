"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { FileCode, Loader2, Lock, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { NginxEditor } from "@/components/nginx-editor";
import { BASE_PATH } from "@/lib/config";
import type { NginxFile, NginxFilesSnapshot } from "@/lib/nginx-config";

type WriteResult = {
  ok: boolean;
  message: string;
  test?: string;
};

/** Human label for a file group heading in the sidebar list. */
const GROUP_LABEL: Record<string, string> = {
  "(root)": "nginx.conf",
  "sites-available": "sites-available",
  "conf.d": "conf.d",
  snippets: "snippets",
  generated: "generated (read-only)",
};
const GROUP_ORDER = ["(root)", "sites-available", "conf.d", "snippets", "generated"];

async function fetchList(): Promise<NginxFile[]> {
  const res = await fetch(`${BASE_PATH}/api/nginx`, { cache: "no-store" });
  const json: NginxFilesSnapshot = await res.json();
  return json.files;
}

export function NginxManager() {
  const [files, setFiles] = useState<NginxFile[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editable, setEditable] = useState(true);
  const [original, setOriginal] = useState("");
  const [draft, setDraft] = useState("");
  // The file whose read last finished; loading until it matches the selection.
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  const dirty = editable && draft !== original;
  const loading = selected !== null && loadedPath !== selected;

  const showList = useCallback((list: NginxFile[]) => {
    setFiles(list);
    // Default to the main public site config when present.
    setSelected(
      (prev) =>
        prev ??
        list.find((f) => f.path === "sites-available/ft-admin")?.path ??
        list.find((f) => f.editable)?.path ??
        list[0]?.path ??
        null,
    );
  }, []);

  const listFailed = useCallback(() => {
    setFiles([]);
    toast.error("Failed to load nginx config list");
  }, []);

  const loadList = useCallback(
    () => fetchList().then(showList, listFailed),
    [showList, listFailed],
  );

  useEffect(() => {
    void fetchList().then(showList, listFailed);
  }, [showList, listFailed]);

  // Load the selected file's contents whenever the selection changes.
  useEffect(() => {
    if (!selected) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch(
          `${BASE_PATH}/api/nginx/file?path=${encodeURIComponent(selected)}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!active) return;
        if (!res.ok) {
          toast.error(json.error ?? "Failed to read file");
          setOriginal("");
          setDraft("");
          return;
        }
        setEditable(json.editable);
        setOriginal(json.content);
        setDraft(json.content);
      } finally {
        if (active) setLoadedPath(selected);
      }
    })();
    return () => {
      active = false;
    };
  }, [selected]);

  const select = (path: string) => {
    if (
      dirty &&
      !window.confirm("Discard unsaved changes to this file?")
    )
      return;
    if (path !== selected) setTest(null);
    setSelected(path);
  };

  const save = async () => {
    if (!selected || !dirty || saving) return;
    setSaving(true);
    setTest(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/nginx/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selected, content: draft }),
      });
      const json: WriteResult = await res.json();
      if (json.test) setTest({ ok: json.ok, text: json.test });
      if (json.ok) {
        setOriginal(draft);
        toast.success(json.message || "Saved and reloaded");
        void loadList();
      } else {
        toast.error(json.message || "Save failed");
      }
    } catch {
      toast.error("Save request failed");
    } finally {
      setSaving(false);
    }
  };

  const grouped = useMemo(() => {
    const map = new Map<string, NginxFile[]>();
    for (const f of files ?? []) {
      const arr = map.get(f.group) ?? [];
      arr.push(f);
      map.set(f.group, arr);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({
      group: g,
      items: map.get(g)!,
    }));
  }, [files]);

  return (
    <div className="flex flex-1 gap-4 overflow-hidden">
      {/* File list */}
      <aside className="w-56 shrink-0 overflow-y-auto rounded-md border">
        {files === null ? (
          <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Loading…
          </div>
        ) : (
          grouped.map(({ group, items }) => (
            <div key={group} className="py-1">
              <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {GROUP_LABEL[group] ?? group}
              </div>
              {items.map((f) => {
                const active = f.path === selected;
                return (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => select(f.path)}
                    title={f.path}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                      active
                        ? "bg-accent font-medium text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    }`}
                  >
                    {f.editable ? (
                      <FileCode className="size-3.5 shrink-0 opacity-70" />
                    ) : (
                      <Lock className="size-3.5 shrink-0 opacity-70" />
                    )}
                    <span className="truncate">{f.name}</span>
                    {f.enabled === false && (
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
                        off
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </aside>

      {/* Editor + actions */}
      <section className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-xs text-muted-foreground">
            {selected ? `/etc/nginx/${selected.replace(/^@generated\//, "")}` : ""}
          </span>
          {!editable && selected && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              read-only
            </span>
          )}
          {dirty && (
            <span className="text-[10px] text-amber-500">● unsaved</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {editable && (
              <Button
                size="sm"
                onClick={save}
                disabled={!dirty || saving}
                title="Back up, save, validate (nginx -t), then reload"
              >
                {saving ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Save className="size-3.5" />
                )}
                Save &amp; reload
              </Button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1">
          {loading ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
            </div>
          ) : (
            <NginxEditor
              value={draft}
              onChange={editable ? setDraft : undefined}
              readOnly={!editable}
            />
          )}
        </div>

        {test && (
          <pre
            className={`max-h-32 shrink-0 overflow-auto rounded-md border p-2 font-mono text-[11px] whitespace-pre-wrap ${
              test.ok
                ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                : "border-red-500/30 text-red-600 dark:text-red-400"
            }`}
          >
            {test.text}
          </pre>
        )}
      </section>
    </div>
  );
}
