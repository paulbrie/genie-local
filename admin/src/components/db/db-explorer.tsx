"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { BASE_PATH } from "@/lib/config";

const API = `${BASE_PATH}/api/db`;

type Engine = "postgres" | "mysql";
type SafeConnection = {
  id: number;
  name: string;
  engine: Engine;
  host: string;
  port: number;
  username: string;
  defaultDatabase: string | null;
  hasPassword: boolean;
};
type TableRef = { schema: string | null; name: string; id: string };
type ColumnInfo = {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimary: boolean;
  default: string | null;
};
type RowsResult = {
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  total: number;
};
type QueryResult =
  | { kind: "rows"; columns: string[]; rows: Record<string, unknown>[] }
  | { kind: "ok"; affectedRows: number; message: string };
type SavedQuery = {
  id: number;
  database: string;
  name: string;
  sql: string;
};

async function jsonOrThrow(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const PAGE = 50;

// Remembers the last place the user was working (connection / database / table /
// active tab) so the explorer reopens where they left off. Persisted per browser.
const SELECTION_KEY = "admin.db-explorer.selection";

type SavedSelection = {
  connId?: number;
  database?: string | null;
  table?: string | null;
  tab?: "browse" | "query";
};

export function DbExplorer() {
  const [connections, setConnections] = useState<SafeConnection[]>([]);
  const [connId, setConnId] = useState<number | null>(null);
  const conn = connections.find((c) => c.id === connId) ?? null;

  const [databases, setDatabases] = useState<string[]>([]);
  const [database, setDatabase] = useState<string | null>(null);
  const [tables, setTables] = useState<TableRef[]>([]);
  const [table, setTable] = useState<string | null>(null);
  const [tab, setTab] = useState<"browse" | "query">("browse");

  // Guards the restore-on-load pass so we don't persist (and clobber saved
  // state) before we've had a chance to read it back.
  const restoredRef = useRef(false);

  const [rows, setRows] = useState<RowsResult | null>(null);
  const [offset, setOffset] = useState(0);
  const [order, setOrder] = useState<{ by?: string; dir: "asc" | "desc" }>({
    dir: "asc",
  });
  const [busy, setBusy] = useState(false);

  const [connSheet, setConnSheet] = useState<{
    open: boolean;
    editing: SafeConnection | null;
  }>({ open: false, editing: null });
  const [rowSheet, setRowSheet] = useState<{
    open: boolean;
    mode: "add" | "edit";
    original: Record<string, unknown> | null;
  }>({ open: false, mode: "add", original: null });
  const [rowToDelete, setRowToDelete] = useState<Record<
    string,
    unknown
  > | null>(null);

  // ----- loaders -----
  const loadConnections = useCallback(async () => {
    try {
      setConnections(await jsonOrThrow(await fetch(`${API}/connections`)));
    } catch (e) {
      toast.error(msg(e));
    }
  }, []);

  const loadDatabases = useCallback(async (id: number) => {
    try {
      const data = await jsonOrThrow(await fetch(`${API}/${id}/databases`));
      setDatabases(data.databases ?? []);
      return data.defaultDatabase as string | null;
    } catch (e) {
      toast.error(`databases: ${msg(e)}`);
      setDatabases([]);
      return null;
    }
  }, []);

  const loadTables = useCallback(async (id: number, dbName: string) => {
    try {
      const data: TableRef[] = await jsonOrThrow(
        await fetch(`${API}/${id}/tables?database=${encodeURIComponent(dbName)}`),
      );
      setTables(data);
    } catch (e) {
      toast.error(`tables: ${msg(e)}`);
      setTables([]);
    }
  }, []);

  const loadRows = useCallback(async () => {
    if (connId == null || !database || !table) return;
    setBusy(true);
    try {
      const p = new URLSearchParams({
        database,
        table,
        limit: String(PAGE),
        offset: String(offset),
        dir: order.dir,
      });
      if (order.by) p.set("orderBy", order.by);
      setRows(await jsonOrThrow(await fetch(`${API}/${connId}/rows?${p}`)));
    } catch (e) {
      toast.error(`rows: ${msg(e)}`);
      setRows(null);
    } finally {
      setBusy(false);
    }
  }, [connId, database, table, offset, order]);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  // Reopen the connection/database/table/tab the user last worked in. Runs once,
  // as soon as connections are known (so we can ignore a stale saved connection).
  useEffect(() => {
    if (restoredRef.current || connections.length === 0) return;
    restoredRef.current = true;

    let saved: SavedSelection | null = null;
    try {
      const raw = localStorage.getItem(SELECTION_KEY);
      if (raw) saved = JSON.parse(raw) as SavedSelection;
    } catch {
      /* ignore malformed / unavailable storage */
    }
    if (!saved || saved.connId == null) return;
    if (!connections.some((c) => c.id === saved.connId)) return; // connection gone

    if (saved.tab === "browse" || saved.tab === "query") setTab(saved.tab);
    void restoreSelection(
      saved.connId,
      saved.database ?? null,
      saved.table ?? null,
    );
    // Only depends on connections becoming available; the ref makes it run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections]);

  // Persist the current selection whenever it changes (after the restore pass).
  useEffect(() => {
    if (!restoredRef.current) return;
    try {
      if (connId == null) {
        localStorage.removeItem(SELECTION_KEY);
      } else {
        localStorage.setItem(
          SELECTION_KEY,
          JSON.stringify({ connId, database, table, tab } satisfies SavedSelection),
        );
      }
    } catch {
      /* storage unavailable — non-fatal */
    }
  }, [connId, database, table, tab]);

  // Like selectConnection, but honors a previously-saved database/table instead
  // of jumping to the server default.
  async function restoreSelection(
    id: number,
    dbName: string | null,
    tbl: string | null,
  ) {
    setConnId(id);
    setDatabase(null);
    setTables([]);
    setTable(null);
    setRows(null);
    const def = await loadDatabases(id);
    const chosenDb = dbName ?? def;
    if (!chosenDb) return;
    setDatabase(chosenDb);
    await loadTables(id, chosenDb);
    if (tbl) setTable(tbl);
  }

  async function selectConnection(id: number) {
    setConnId(id);
    setDatabase(null);
    setTables([]);
    setTable(null);
    setRows(null);
    const def = await loadDatabases(id);
    if (def) {
      setDatabase(def);
      await loadTables(id, def);
    }
  }

  async function selectDatabase(dbName: string) {
    setDatabase(dbName);
    setTable(null);
    setRows(null);
    if (connId != null) await loadTables(connId, dbName);
  }

  function selectTable(id: string) {
    setTable(id);
    setOffset(0);
    setOrder({ dir: "asc" });
  }

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  const pkColumns = rows?.columns.filter((c) => c.isPrimary) ?? [];
  const canEdit = pkColumns.length > 0;

  function pkOf(row: Record<string, unknown>): Record<string, unknown> {
    const pk: Record<string, unknown> = {};
    for (const c of pkColumns) pk[c.name] = row[c.name];
    return pk;
  }

  async function submitRow(values: Record<string, unknown>) {
    if (connId == null || !database || !table) return;
    try {
      if (rowSheet.mode === "add") {
        await jsonOrThrow(
          await fetch(`${API}/${connId}/rows`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ database, table, values }),
          }),
        );
        toast.success("Row inserted");
      } else {
        const pk = pkOf(rowSheet.original ?? {});
        await jsonOrThrow(
          await fetch(`${API}/${connId}/rows`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ database, table, pk, values }),
          }),
        );
        toast.success("Row updated");
      }
      setRowSheet({ open: false, mode: "add", original: null });
      loadRows();
    } catch (e) {
      toast.error(msg(e));
    }
  }

  async function confirmDeleteRow() {
    const row = rowToDelete;
    if (row == null || connId == null || !database || !table) {
      setRowToDelete(null);
      return;
    }
    try {
      await jsonOrThrow(
        await fetch(`${API}/${connId}/rows`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ database, table, pk: pkOf(row) }),
        }),
      );
      toast.success("Row deleted");
      loadRows();
    } catch (e) {
      toast.error(msg(e));
    } finally {
      setRowToDelete(null);
    }
  }

  return (
    <div className="flex min-h-[70vh] gap-4">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 space-y-3 border-r pr-4">
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Connection</Label>
            <button
              className="text-xs text-muted-foreground hover:underline"
              onClick={() => setConnSheet({ open: true, editing: null })}
            >
              + Add
            </button>
          </div>
          <Select
            value={connId != null ? String(connId) : null}
            onValueChange={(v) => v && selectConnection(Number(v))}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a connection…" />
            </SelectTrigger>
            <SelectContent>
              {connections.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name} · {c.engine}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {conn && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">
                {conn.username}@{conn.host}:{conn.port}
              </span>
              <button
                className="hover:underline"
                onClick={() => setConnSheet({ open: true, editing: conn })}
              >
                edit
              </button>
            </div>
          )}
        </div>

        {conn && (
          <div className="space-y-1">
            <Label className="text-xs">Database</Label>
            <Select
              value={database}
              onValueChange={(v) => v && selectDatabase(v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a database…" />
              </SelectTrigger>
              <SelectContent>
                {databases.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {database && (
          <div className="space-y-1">
            <Label className="text-xs">Tables ({tables.length})</Label>
            <div className="max-h-[50vh] overflow-auto rounded-md border">
              {tables.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">No tables.</p>
              ) : (
                tables.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => selectTable(t.id)}
                    className={`block w-full truncate px-2 py-1 text-left text-sm hover:bg-muted ${
                      table === t.id ? "bg-muted font-medium" : ""
                    }`}
                  >
                    {t.id}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </aside>

      {/* Main */}
      <div className="min-w-0 flex-1">
        {!conn ? (
          <Empty text="Select or add a connection to begin." />
        ) : (
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as "browse" | "query")}
          >
            <TabsList>
              <TabsTrigger value="browse">Browse</TabsTrigger>
              <TabsTrigger value="query">Query</TabsTrigger>
            </TabsList>

            <TabsContent value="browse" className="pt-3">
              {!table ? (
                <Empty text="Select a table." />
              ) : (
                <BrowseTable
                  rows={rows}
                  busy={busy}
                  offset={offset}
                  canEdit={canEdit}
                  order={order}
                  onSort={(by) =>
                    setOrder((o) =>
                      o.by === by
                        ? { by, dir: o.dir === "asc" ? "desc" : "asc" }
                        : { by, dir: "asc" },
                    )
                  }
                  onPrev={() => setOffset((o) => Math.max(0, o - PAGE))}
                  onNext={() => setOffset((o) => o + PAGE)}
                  onAdd={() =>
                    setRowSheet({ open: true, mode: "add", original: null })
                  }
                  onEdit={(row) =>
                    setRowSheet({ open: true, mode: "edit", original: row })
                  }
                  onDelete={setRowToDelete}
                />
              )}
            </TabsContent>

            <TabsContent value="query" className="pt-3">
              {connId != null && database ? (
                <QueryRunner connId={connId} database={database} />
              ) : (
                <Empty text="Select a database first." />
              )}
            </TabsContent>
          </Tabs>
        )}
      </div>

      {/* Right drawer: row add/edit */}
      <RowSheet
        state={rowSheet}
        columns={rows?.columns ?? []}
        canEdit={canEdit}
        onClose={() =>
          setRowSheet({ open: false, mode: "add", original: null })
        }
        onSubmit={submitRow}
      />

      {/* Right drawer: connection add/edit */}
      <ConnectionSheet
        state={connSheet}
        onClose={() => setConnSheet({ open: false, editing: null })}
        onSaved={async (savedId) => {
          setConnSheet({ open: false, editing: null });
          await loadConnections();
          if (savedId != null) selectConnection(savedId);
        }}
      />

      {/* Confirm row deletion */}
      <AlertDialog
        open={rowToDelete !== null}
        onOpenChange={(o) => !o && setRowToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this row?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the row from{" "}
              <code className="font-mono">{table}</code>. This can&rsquo;t be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {rowToDelete && pkColumns.length > 0 && (
            <pre className="max-h-40 overflow-auto rounded-md border bg-muted/40 p-2 text-xs">
              {pkColumns
                .map((c) => `${c.name}: ${cellToString(rowToDelete[c.name])}`)
                .join("\n")}
            </pre>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={confirmDeleteRow}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------- Browse table ----------------

function BrowseTable({
  rows,
  busy,
  offset,
  canEdit,
  order,
  onSort,
  onPrev,
  onNext,
  onAdd,
  onEdit,
  onDelete,
}: {
  rows: RowsResult | null;
  busy: boolean;
  offset: number;
  canEdit: boolean;
  order: { by?: string; dir: "asc" | "desc" };
  onSort: (col: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onAdd: () => void;
  onEdit: (row: Record<string, unknown>) => void;
  onDelete: (row: Record<string, unknown>) => void;
}) {
  if (!rows) return <Empty text={busy ? "Loading…" : "No data."} />;
  const shown = rows.rows.length;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onAdd}>
          + Add row
        </Button>
        {!canEdit && (
          <Badge variant="outline">no primary key — edit/delete disabled</Badge>
        )}
        <span className="ml-auto text-sm text-muted-foreground">
          {rows.total.toLocaleString()} rows · showing {offset + 1}–
          {offset + shown}
        </span>
        <Button size="sm" variant="outline" onClick={onPrev} disabled={offset === 0}>
          Prev
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onNext}
          disabled={offset + shown >= rows.total}
        >
          Next
        </Button>
      </div>

      <div className="overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {rows.columns.map((c) => (
                <TableHead key={c.name} className="whitespace-nowrap">
                  <button
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() => onSort(c.name)}
                    title={`${c.dataType}${c.isPrimary ? " · PK" : ""}`}
                  >
                    {c.name}
                    {c.isPrimary && <span className="text-amber-500">★</span>}
                    {order.by === c.name && (
                      <span>{order.dir === "asc" ? "▲" : "▼"}</span>
                    )}
                  </button>
                </TableHead>
              ))}
              <TableHead className="w-24 text-right">actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.rows.map((row, i) => (
              <TableRow key={i}>
                {rows.columns.map((c) => (
                  <TableCell
                    key={c.name}
                    className="max-w-[22rem] truncate font-mono text-xs"
                    title={cellToString(row[c.name])}
                  >
                    {row[c.name] === null ? (
                      <span className="text-muted-foreground italic">null</span>
                    ) : (
                      cellToString(row[c.name])
                    )}
                  </TableCell>
                ))}
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground hover:underline disabled:opacity-40"
                      onClick={() => onEdit(row)}
                      disabled={!canEdit}
                    >
                      edit
                    </button>
                    <button
                      className="text-xs text-destructive hover:underline disabled:opacity-40"
                      onClick={() => onDelete(row)}
                      disabled={!canEdit}
                    >
                      del
                    </button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ---------------- Row add/edit drawer ----------------

type FieldState = { value: string; isNull: boolean };

function RowSheet({
  state,
  columns,
  canEdit,
  onClose,
  onSubmit,
}: {
  state: { open: boolean; mode: "add" | "edit"; original: Record<string, unknown> | null };
  columns: ColumnInfo[];
  canEdit: boolean;
  onClose: () => void;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
}) {
  const [fields, setFields] = useState<Record<string, FieldState>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!state.open) return;
    const init: Record<string, FieldState> = {};
    for (const c of columns) {
      const v = state.original?.[c.name];
      init[c.name] = {
        value: v === null || v === undefined ? "" : stringifyValue(v),
        isNull: state.mode === "edit" ? v === null || v === undefined : false,
      };
    }
    setFields(init);
  }, [state.open, state.mode, state.original, columns]);

  function set(name: string, patch: Partial<FieldState>) {
    setFields((f) => ({ ...f, [name]: { ...f[name], ...patch } }));
  }

  async function handleSubmit() {
    const values: Record<string, unknown> = {};
    for (const c of columns) {
      // On edit, PK columns are the identifier (WHERE), not updated here.
      if (state.mode === "edit" && c.isPrimary) continue;
      const f = fields[c.name];
      if (!f) continue;
      // On add, skip untouched empty non-null fields so DB defaults apply.
      if (state.mode === "add" && !f.isNull && f.value === "") continue;
      values[c.name] = f.isNull ? null : f.value;
    }
    setSubmitting(true);
    try {
      await onSubmit(values);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet open={state.open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            {state.mode === "add" ? "Add row" : "Edit row"}
          </SheetTitle>
          <SheetDescription>
            {state.mode === "edit" && !canEdit
              ? "This table has no primary key."
              : "Leave a field on NULL to store NULL; empty text is an empty string."}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-3 overflow-auto px-4">
          {columns.map((c) => {
            const f = fields[c.name] ?? { value: "", isNull: false };
            const readOnly = state.mode === "edit" && c.isPrimary;
            return (
              <div key={c.name} className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">
                    {c.name}
                    {c.isPrimary && <span className="ml-1 text-amber-500">★</span>}
                    <span className="ml-1 font-normal text-muted-foreground">
                      {c.dataType}
                    </span>
                  </Label>
                  {c.nullable && !readOnly && (
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={f.isNull}
                        onChange={(e) => set(c.name, { isNull: e.target.checked })}
                      />
                      NULL
                    </label>
                  )}
                </div>
                <Input
                  value={f.isNull ? "" : f.value}
                  disabled={readOnly || f.isNull}
                  placeholder={f.isNull ? "NULL" : (c.default ?? "")}
                  onChange={(e) => set(c.name, { value: e.target.value })}
                />
              </div>
            );
          })}
        </div>

        <SheetFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || (state.mode === "edit" && !canEdit)}
          >
            {submitting
              ? state.mode === "add"
                ? "Inserting…"
                : "Saving…"
              : state.mode === "add"
                ? "Insert"
                : "Save"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ---------------- Connection add/edit drawer ----------------

function ConnectionSheet({
  state,
  onClose,
  onSaved,
}: {
  state: { open: boolean; editing: SafeConnection | null };
  onClose: () => void;
  onSaved: (id: number | null) => void;
}) {
  const editing = state.editing;
  const [form, setForm] = useState({
    name: "",
    engine: "postgres" as Engine,
    host: "127.0.0.1",
    port: "5432",
    username: "",
    password: "",
    defaultDatabase: "",
  });
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (!state.open) return;
    if (editing) {
      setForm({
        name: editing.name,
        engine: editing.engine,
        host: editing.host,
        port: String(editing.port),
        username: editing.username,
        password: "",
        defaultDatabase: editing.defaultDatabase ?? "",
      });
    } else {
      setForm({
        name: "",
        engine: "postgres",
        host: "127.0.0.1",
        port: "5432",
        username: "",
        password: "",
        defaultDatabase: "",
      });
    }
  }, [state.open, editing]);

  function upd(patch: Partial<typeof form>) {
    setForm((f) => ({ ...f, ...patch }));
  }

  async function save() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        engine: form.engine,
        host: form.host,
        port: Number(form.port),
        username: form.username,
        defaultDatabase: form.defaultDatabase || null,
      };
      // Only send password if the user typed one (keeps existing on edit).
      if (form.password) body.password = form.password;
      else if (!editing) body.password = null;

      const res = editing
        ? await fetch(`${API}/connections/${editing.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await fetch(`${API}/connections`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
      const saved = await jsonOrThrow(res);
      toast.success(editing ? "Connection updated" : "Connection added");
      onSaved(saved.id ?? editing?.id ?? null);
    } catch (e) {
      toast.error(msg(e));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    if (!editing) {
      toast.message("Save the connection first, then test.");
      return;
    }
    try {
      const r = await jsonOrThrow(await fetch(`${API}/${editing.id}/test`));
      r.ok ? toast.success("Connection OK") : toast.error(r.error ?? "failed");
    } catch (e) {
      toast.error(msg(e));
    }
  }

  async function remove() {
    if (!editing) return;
    try {
      await jsonOrThrow(
        await fetch(`${API}/connections/${editing.id}`, { method: "DELETE" }),
      );
      toast.success("Connection deleted");
      onSaved(null);
    } catch (e) {
      toast.error(msg(e));
    } finally {
      setConfirmingDelete(false);
    }
  }

  return (
    <Sheet open={state.open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{editing ? "Edit connection" : "Add connection"}</SheetTitle>
          <SheetDescription>
            Passwords are encrypted at rest (AES-GCM).
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-3 overflow-auto px-4">
          <Field label="Name">
            <Input value={form.name} onChange={(e) => upd({ name: e.target.value })} />
          </Field>
          <Field label="Engine">
            <Select
              value={form.engine}
              onValueChange={(v) =>
                v &&
                upd({
                  engine: v as Engine,
                  port: v === "mysql" ? "3306" : "5432",
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="postgres">PostgreSQL</SelectItem>
                <SelectItem value="mysql">MySQL</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <Field label="Host">
                <Input value={form.host} onChange={(e) => upd({ host: e.target.value })} />
              </Field>
            </div>
            <Field label="Port">
              <Input
                value={form.port}
                inputMode="numeric"
                onChange={(e) => upd({ port: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Username">
            <Input
              value={form.username}
              onChange={(e) => upd({ username: e.target.value })}
            />
          </Field>
          <Field label={editing ? "Password (blank = keep)" : "Password"}>
            <Input
              type="password"
              value={form.password}
              onChange={(e) => upd({ password: e.target.value })}
            />
          </Field>
          <Field label="Default database (optional)">
            <Input
              value={form.defaultDatabase}
              onChange={(e) => upd({ defaultDatabase: e.target.value })}
            />
          </Field>
        </div>

        <SheetFooter className="flex-row flex-wrap justify-between gap-2">
          <div className="flex gap-2">
            {editing && (
              <>
                <Button variant="outline" size="sm" onClick={test}>
                  Test
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete
                </Button>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>

      <AlertDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete connection?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the saved connection{" "}
              <span className="font-medium">{editing?.name}</span> (host,
              credentials). The database itself is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={remove}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}

// ---------------- Query runner ----------------

function QueryRunner({ connId, database }: { connId: number; database: string }) {
  const [sql, setSql] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [saved, setSaved] = useState<SavedQuery[]>([]);

  const loadSaved = useCallback(async () => {
    try {
      setSaved(
        await jsonOrThrow(
          await fetch(
            `${API}/${connId}/queries?database=${encodeURIComponent(database)}`,
          ),
        ),
      );
    } catch {
      setSaved([]);
    }
  }, [connId, database]);

  useEffect(() => {
    loadSaved();
  }, [loadSaved]);

  async function run() {
    if (!sql.trim()) return;
    setRunning(true);
    setError(null);
    try {
      const r: QueryResult = await jsonOrThrow(
        await fetch(`${API}/${connId}/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ database, sql }),
        }),
      );
      setResult(r);
    } catch (e) {
      setResult(null);
      setError(msg(e));
    } finally {
      setRunning(false);
    }
  }

  async function saveCurrent() {
    const name = prompt("Save query as:");
    if (!name) return;
    try {
      await jsonOrThrow(
        await fetch(`${API}/${connId}/queries`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ database, name, sql }),
        }),
      );
      toast.success("Query saved");
      loadSaved();
    } catch (e) {
      toast.error(msg(e));
    }
  }

  async function deleteSaved(id: number) {
    try {
      await jsonOrThrow(
        await fetch(`${API}/queries/${id}`, { method: "DELETE" }),
      );
      loadSaved();
    } catch (e) {
      toast.error(msg(e));
    }
  }

  return (
    <div className="flex gap-4">
      <div className="min-w-0 flex-1 space-y-2">
        <Textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          placeholder={`SELECT * FROM … (runs against "${database}")`}
          rows={6}
          className="font-mono text-sm"
        />
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={run} disabled={running}>
            {running ? "Running…" : "Run"}
          </Button>
          <Button size="sm" variant="outline" onClick={saveCurrent} disabled={!sql.trim()}>
            Save query
          </Button>
          <span className="text-xs text-muted-foreground">
            runs on <code>{database}</code>
          </span>
        </div>

        {error && (
          <pre className="whitespace-pre-wrap rounded-md border border-destructive/50 bg-destructive/5 p-3 text-xs text-destructive">
            {error}
          </pre>
        )}
        {result?.kind === "ok" && (
          <p className="rounded-md border bg-muted/40 p-3 text-sm">
            {result.message}
          </p>
        )}
        {result?.kind === "rows" && (
          <div className="overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  {result.columns.map((c) => (
                    <TableHead key={c} className="whitespace-nowrap">
                      {c}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.map((row, i) => (
                  <TableRow key={i}>
                    {result.columns.map((c) => (
                      <TableCell
                        key={c}
                        className="max-w-[22rem] truncate font-mono text-xs"
                        title={cellToString(row[c])}
                      >
                        {cellToString(row[c])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {result.rows.length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">0 rows.</p>
            )}
          </div>
        )}
      </div>

      <div className="w-56 shrink-0 space-y-2 border-l pl-4">
        <Label className="text-xs">Saved queries</Label>
        {saved.length === 0 ? (
          <p className="text-xs text-muted-foreground">None for this database.</p>
        ) : (
          <ul className="space-y-1">
            {saved.map((q) => (
              <li key={q.id} className="flex items-center justify-between gap-2">
                <button
                  className="truncate text-left text-sm hover:underline"
                  title={q.sql}
                  onClick={() => setSql(q.sql)}
                >
                  {q.name}
                </button>
                <button
                  className="text-xs text-destructive hover:underline"
                  onClick={() => deleteSaved(q.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------- small helpers ----------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function stringifyValue(v: unknown): string {
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
