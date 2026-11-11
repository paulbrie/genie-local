// Pure, dependency-free (tested): the DB Explorer's databases found on this box (db-discovery.ts does the reading).

/**
 * What a project's env file, a database container or the admin's own DATABASE_URL say about a database on this box,
 * as an explorer connection: one per server and user, whose databases the explorer lists (so admin_app on :5432 is
 * one connection for every database it owns).
 */
export type FoundConn = {
  /** engine, host, port and user: what makes it the same connection, wherever it was found */
  key: string;
  name: string;
  engine: "postgres" | "mysql";
  host: string;
  port: number;
  username: string;
  password: string | null;
  defaultDatabase: string | null;
  /** where it was found, first first: "mecharena/.env", "docker mecharena-postgres-1" */
  from: string[];
};

type Conn = Omit<FoundConn, "key" | "name" | "from">;

const PORTS = { postgres: 5432, mysql: 3306 } as const;
/** Hosts that are this box: a URL naming another is someone else's database, left out. */
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** The same connection whatever the host's spelling (localhost, ::1 and 127.0.0.1 are one). */
export function connKey(c: Pick<Conn, "engine" | "host" | "port" | "username">): string {
  return `${c.engine}|${LOCAL.has(c.host) ? "127.0.0.1" : c.host}|${c.port}|${c.username}`;
}

/** A postgres:// / postgresql:// / mysql:// / mariadb:// URL to a database on this box, as a connection (null: not one). */
export function connFromUrl(raw: string): Conn | null {
  const m = /^(postgres(?:ql)?|mysql|mariadb):\/\//i.exec(raw.trim());
  if (!m) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!LOCAL.has(u.hostname)) return null;
  const engine = m[1].toLowerCase().startsWith("postgres") ? "postgres" : "mysql";
  const port = u.port ? Number(u.port) : PORTS[engine];
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const username = dec(u.username) || (engine === "postgres" ? "postgres" : "root");
  const db = dec(u.pathname.replace(/^\//, ""));
  return { engine, host: "127.0.0.1", port, username, password: u.password ? dec(u.password) : null, defaultDatabase: db || null };
}

/** The values in a dotenv file that are database URLs (`KEY=value`, `export KEY=value`, quoted or not). */
export function dbUrlsInEnv(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?[A-Za-z_][\w.]*\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[1].trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0) v = v.slice(1, v.indexOf(q, 1));
    else v = v.replace(/\s+#.*$/, "");
    if (/^(postgres(?:ql)?|mysql|mariadb):\/\//i.test(v)) out.push(v);
  }
  return out;
}

/** A running container, as `docker inspect` tells it (the parts that matter here). */
export type ContainerInfo = {
  name: string;
  image: string;
  env: string[];
  /** "5432/tcp" → its bindings on the host (null: not published) */
  ports: Record<string, { HostIp?: string; HostPort?: string }[] | null>;
  /** its address on a bridge network, reachable from the host */
  ip: string | null;
  hostNetwork: boolean;
};

/** The image is a database's: postgres (postgis, timescale, pgvector, bitnami's…) or mysql / mariadb. */
function engineOfImage(image: string): "postgres" | "mysql" | null {
  const repo = image.split("@")[0].replace(/:[^/:]*$/, "");
  const last = repo.split("/").pop()!.toLowerCase();
  if (/^(postgres|postgresql|postgis|timescaledb(-ha)?|pgvector)$/.test(last)) return "postgres";
  if (/^(mysql|mariadb|percona(-server)?)$/.test(last)) return "mysql";
  return null;
}

/**
 * A database container as a connection: the user, password and database its image's env sets up, at the port it
 * publishes on this box (else its address on its network, which the host reaches too). Null: not a database, or
 * one whose password isn't in its env (a random root password, a password file).
 */
export function connFromContainer(c: ContainerInfo): Conn | null {
  const engine = engineOfImage(c.image);
  if (!engine) return null;
  const env = new Map(
    c.env.map((e) => {
      const i = e.indexOf("=");
      return [e.slice(0, i), e.slice(i + 1)] as const;
    }),
  );
  const get = (...keys: string[]) => keys.map((k) => env.get(k)).find((v) => v !== undefined && v !== "") ?? null;
  let username: string;
  let password: string | null;
  let defaultDatabase: string | null;
  if (engine === "postgres") {
    username = get("POSTGRES_USER", "POSTGRESQL_USERNAME") ?? "postgres";
    password = get("POSTGRES_PASSWORD", "POSTGRESQL_PASSWORD");
    if (!password && get("POSTGRES_HOST_AUTH_METHOD") !== "trust" && !get("ALLOW_EMPTY_PASSWORD")) return null;
    defaultDatabase = get("POSTGRES_DB", "POSTGRESQL_DATABASE") ?? username;
  } else {
    const root = get("MYSQL_ROOT_PASSWORD", "MARIADB_ROOT_PASSWORD");
    const emptyRoot = !!get("MYSQL_ALLOW_EMPTY_PASSWORD", "MARIADB_ALLOW_EMPTY_ROOT_PASSWORD", "ALLOW_EMPTY_PASSWORD");
    const user = get("MYSQL_USER", "MARIADB_USER");
    if (root || emptyRoot) [username, password] = ["root", root];
    else if (user) [username, password] = [user, get("MYSQL_PASSWORD", "MARIADB_PASSWORD")];
    else return null;
    defaultDatabase = get("MYSQL_DATABASE", "MARIADB_DATABASE");
  }
  const inner = Number(get(engine === "postgres" ? "PGPORT" : "MYSQL_TCP_PORT") ?? PORTS[engine]);
  const bound = (c.ports[`${inner}/tcp`] ?? []).find((b) => b.HostPort && ["", "0.0.0.0", "127.0.0.1", "::"].includes(b.HostIp ?? ""));
  const [host, port] = bound ? ["127.0.0.1", Number(bound.HostPort)] : c.hostNetwork ? ["127.0.0.1", inner] : c.ip ? [c.ip, inner] : [null, 0];
  if (!host) return null;
  return { engine, host, port, username, password, defaultDatabase };
}

/** One connection per key: the first found names it (and its database is the default), the others add where they were. */
export function mergeFound(list: readonly { conn: Conn; name: string; from: string }[]): FoundConn[] {
  const byKey = new Map<string, FoundConn>();
  for (const { conn, name, from } of list) {
    const key = connKey(conn);
    const cur = byKey.get(key);
    if (cur) {
      if (!cur.from.includes(from)) cur.from.push(from);
      if (!cur.password && conn.password) cur.password = conn.password;
    } else byKey.set(key, { ...conn, key, name, from: [from] });
  }
  return [...byKey.values()];
}
