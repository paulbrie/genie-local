import "server-only";

import mysql from "mysql2/promise";
import { Client as PgClient } from "pg";

import type { ResolvedConnection } from "@/lib/connections";

export type ColumnInfo = {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimary: boolean;
  default: string | null;
};

export type TableRef = { schema: string | null; name: string; id: string };

export type RowsResult = {
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  total: number;
};

export type QueryResult =
  | { kind: "rows"; columns: string[]; rows: Record<string, unknown>[] }
  | { kind: "ok"; affectedRows: number; message: string };

// ---------- identifier quoting / placeholders ----------

function qIdent(engine: string, name: string): string {
  if (engine === "mysql") return "`" + name.replace(/`/g, "``") + "`";
  return '"' + name.replace(/"/g, '""') + '"';
}

/** Fully-qualified, safely-quoted table reference. */
function qTable(engine: string, t: TableRef): string {
  if (engine === "mysql") return qIdent(engine, t.name);
  return t.schema
    ? `${qIdent(engine, t.schema)}.${qIdent(engine, t.name)}`
    : qIdent(engine, t.name);
}

function ph(engine: string, i: number): string {
  return engine === "mysql" ? "?" : `$${i}`;
}

/** Make DB values JSON-safe (Dates, Buffers, bigint, etc.). */
function normalize(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString("base64");
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "object") return v; // pg jsonb / mysql json come back parsed
  return v;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = normalize(v);
  return out;
}

export function parseTableId(engine: string, id: string): TableRef {
  if (engine === "mysql") return { schema: null, name: id, id };
  const dot = id.indexOf(".");
  return dot === -1
    ? { schema: "public", name: id, id }
    : { schema: id.slice(0, dot), name: id.slice(dot + 1), id };
}

// ---------- connection helpers (per-request, no shared pool) ----------

async function withPg<T>(
  conn: ResolvedConnection,
  database: string | null,
  fn: (c: PgClient) => Promise<T>,
): Promise<T> {
  const client = new PgClient({
    host: conn.host,
    port: conn.port,
    user: conn.username,
    password: conn.password ?? undefined,
    database: database ?? conn.defaultDatabase ?? "postgres",
    connectionTimeoutMillis: 8000,
    statement_timeout: 20000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function withMysql<T>(
  conn: ResolvedConnection,
  database: string | null,
  fn: (c: mysql.Connection) => Promise<T>,
): Promise<T> {
  const c = await mysql.createConnection({
    host: conn.host,
    port: conn.port,
    user: conn.username,
    password: conn.password ?? undefined,
    database: database ?? conn.defaultDatabase ?? undefined,
    connectTimeout: 8000,
    dateStrings: false,
    multipleStatements: false,
  });
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

// ---------- introspection ----------

export async function listDatabases(
  conn: ResolvedConnection,
): Promise<string[]> {
  if (conn.engine === "postgres") {
    return withPg(conn, null, async (c) => {
      const r = await c.query(
        "SELECT datname FROM pg_database WHERE datistemplate=false AND datallowconn ORDER BY datname",
      );
      return r.rows.map((x) => x.datname as string);
    });
  }
  return withMysql(conn, null, async (c) => {
    const [rows] = await c.query("SHOW DATABASES");
    return (rows as Record<string, unknown>[]).map(
      (r) => Object.values(r)[0] as string,
    );
  });
}

export async function listTables(
  conn: ResolvedConnection,
  database: string,
): Promise<TableRef[]> {
  if (conn.engine === "postgres") {
    return withPg(conn, database, async (c) => {
      const r = await c.query(
        `SELECT table_schema, table_name FROM information_schema.tables
         WHERE table_type='BASE TABLE'
           AND table_schema NOT IN ('pg_catalog','information_schema')
         ORDER BY table_schema, table_name`,
      );
      return r.rows.map((x) => {
        const schema = x.table_schema as string;
        const name = x.table_name as string;
        const id = schema === "public" ? name : `${schema}.${name}`;
        return { schema, name, id };
      });
    });
  }
  return withMysql(conn, database, async (c) => {
    // Alias explicitly: MySQL 8 information_schema returns UPPERCASE keys.
    const [rows] = await c.query(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema=? AND table_type='BASE TABLE' ORDER BY table_name`,
      [database],
    );
    return (rows as Record<string, unknown>[]).map((r) => {
      const name = String(r.name);
      return { schema: null, name, id: name };
    });
  });
}

export async function getColumns(
  conn: ResolvedConnection,
  database: string,
  tableId: string,
): Promise<ColumnInfo[]> {
  const t = parseTableId(conn.engine, tableId);
  if (conn.engine === "postgres") {
    return withPg(conn, database, async (c) => {
      const cols = await c.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema=$1 AND table_name=$2
         ORDER BY ordinal_position`,
        [t.schema, t.name],
      );
      const pk = await c.query(
        `SELECT a.attname FROM pg_index i
         JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = ($1)::regclass AND i.indisprimary`,
        [qTable(conn.engine, t)],
      );
      const pks = new Set(pk.rows.map((r) => r.attname as string));
      return cols.rows.map((r) => ({
        name: r.column_name as string,
        dataType: r.data_type as string,
        nullable: r.is_nullable === "YES",
        isPrimary: pks.has(r.column_name as string),
        default: (r.column_default as string) ?? null,
      }));
    });
  }
  return withMysql(conn, database, async (c) => {
    const [rows] = await c.query(
      `SELECT column_name, data_type, is_nullable, column_default, column_key
       FROM information_schema.columns
       WHERE table_schema=? AND table_name=? ORDER BY ordinal_position`,
      [database, t.name],
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      name: (r.column_name ?? r.COLUMN_NAME) as string,
      dataType: (r.data_type ?? r.DATA_TYPE) as string,
      nullable: (r.is_nullable ?? r.IS_NULLABLE) === "YES",
      isPrimary: (r.column_key ?? r.COLUMN_KEY) === "PRI",
      default: ((r.column_default ?? r.COLUMN_DEFAULT) as string) ?? null,
    }));
  });
}

// ---------- data ----------

export async function getRows(
  conn: ResolvedConnection,
  database: string,
  tableId: string,
  opts: { limit: number; offset: number; orderBy?: string; dir?: "asc" | "desc" },
): Promise<RowsResult> {
  const t = parseTableId(conn.engine, tableId);
  const columns = await getColumns(conn, database, tableId);
  const colNames = new Set(columns.map((c) => c.name));
  const limit = Math.min(Math.max(1, opts.limit), 500);
  const offset = Math.max(0, opts.offset);
  const dir = opts.dir === "desc" ? "DESC" : "ASC";
  const orderBy =
    opts.orderBy && colNames.has(opts.orderBy) ? opts.orderBy : null;
  const orderSql = orderBy
    ? ` ORDER BY ${qIdent(conn.engine, orderBy)} ${dir}`
    : "";
  const tbl = qTable(conn.engine, t);

  const run = async (
    query: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>,
    count: (sql: string) => Promise<number>,
  ): Promise<RowsResult> => {
    const rows = await query(
      `SELECT * FROM ${tbl}${orderSql} LIMIT ${limit} OFFSET ${offset}`,
      [],
    );
    const total = await count(`SELECT COUNT(*) AS n FROM ${tbl}`);
    return { columns, rows: rows.map(normalizeRow), total };
  };

  if (conn.engine === "postgres") {
    return withPg(conn, database, (c) =>
      run(
        async (sql) => (await c.query(sql)).rows,
        async (sql) => Number((await c.query(sql)).rows[0].n),
      ),
    );
  }
  return withMysql(conn, database, (c) =>
    run(
      async (sql) => (await c.query(sql))[0] as Record<string, unknown>[],
      async (sql) => {
        const [r] = await c.query(sql);
        return Number((r as Record<string, unknown>[])[0].n);
      },
    ),
  );
}

function buildPkWhere(
  engine: string,
  pk: Record<string, unknown>,
  startIndex: number,
): { clause: string; params: unknown[] } {
  const keys = Object.keys(pk);
  const params: unknown[] = [];
  const clause = keys
    .map((k, i) => {
      params.push(pk[k]);
      return `${qIdent(engine, k)} = ${ph(engine, startIndex + i)}`;
    })
    .join(" AND ");
  return { clause, params };
}

export async function insertRow(
  conn: ResolvedConnection,
  database: string,
  tableId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const t = parseTableId(conn.engine, tableId);
  const cols = Object.keys(values);
  if (cols.length === 0) throw new Error("no values to insert");
  const tbl = qTable(conn.engine, t);
  const colSql = cols.map((c) => qIdent(conn.engine, c)).join(", ");
  const placeholders = cols
    .map((_, i) => ph(conn.engine, i + 1))
    .join(", ");
  const params = cols.map((c) => values[c]);
  const sql = `INSERT INTO ${tbl} (${colSql}) VALUES (${placeholders})`;
  if (conn.engine === "postgres") {
    await withPg(conn, database, (c) => c.query(sql, params));
  } else {
    await withMysql(conn, database, (c) => c.query(sql, params));
  }
}

export async function updateRow(
  conn: ResolvedConnection,
  database: string,
  tableId: string,
  pk: Record<string, unknown>,
  values: Record<string, unknown>,
): Promise<void> {
  const t = parseTableId(conn.engine, tableId);
  const cols = Object.keys(values);
  if (cols.length === 0) throw new Error("no values to update");
  const tbl = qTable(conn.engine, t);
  const setParams = cols.map((c) => values[c]);
  const setSql = cols
    .map((c, i) => `${qIdent(conn.engine, c)} = ${ph(conn.engine, i + 1)}`)
    .join(", ");
  const where = buildPkWhere(conn.engine, pk, cols.length + 1);
  const sql = `UPDATE ${tbl} SET ${setSql} WHERE ${where.clause}`;
  const params = [...setParams, ...where.params];
  if (conn.engine === "postgres") {
    await withPg(conn, database, (c) => c.query(sql, params));
  } else {
    await withMysql(conn, database, (c) => c.query(sql, params));
  }
}

export async function deleteRow(
  conn: ResolvedConnection,
  database: string,
  tableId: string,
  pk: Record<string, unknown>,
): Promise<void> {
  const t = parseTableId(conn.engine, tableId);
  const tbl = qTable(conn.engine, t);
  const where = buildPkWhere(conn.engine, pk, 1);
  const sql = `DELETE FROM ${tbl} WHERE ${where.clause}`;
  if (conn.engine === "postgres") {
    await withPg(conn, database, (c) => c.query(sql, where.params));
  } else {
    await withMysql(conn, database, (c) => c.query(sql, where.params));
  }
}

export async function runQuery(
  conn: ResolvedConnection,
  database: string,
  sql: string,
): Promise<QueryResult> {
  if (conn.engine === "postgres") {
    return withPg(conn, database, async (c) => {
      const r = await c.query(sql);
      if (r.command === "SELECT" || (r.rows && r.rows.length > 0)) {
        return {
          kind: "rows",
          columns: r.fields.map((f) => f.name),
          rows: r.rows.map(normalizeRow),
        };
      }
      return {
        kind: "ok",
        affectedRows: r.rowCount ?? 0,
        message: `${r.command} — ${r.rowCount ?? 0} row(s)`,
      };
    });
  }
  return withMysql(conn, database, async (c) => {
    const [result, fields] = await c.query(sql);
    if (Array.isArray(result)) {
      const rows = result as Record<string, unknown>[];
      const cols =
        fields && Array.isArray(fields)
          ? (fields as { name: string }[]).map((f) => f.name)
          : rows.length
            ? Object.keys(rows[0])
            : [];
      return { kind: "rows", columns: cols, rows: rows.map(normalizeRow) };
    }
    const header = result as { affectedRows?: number };
    return {
      kind: "ok",
      affectedRows: header.affectedRows ?? 0,
      message: `OK — ${header.affectedRows ?? 0} row(s) affected`,
    };
  });
}

/** Quick connectivity test — returns null on success, else an error message. */
export async function testConnection(
  conn: ResolvedConnection,
): Promise<string | null> {
  try {
    await listDatabases(conn);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
