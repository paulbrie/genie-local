import "server-only";

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import { syncFoundConnections } from "@/lib/connections";
import { type ContainerInfo, connFromContainer, connFromUrl, dbUrlsInEnv, type FoundConn, mergeFound } from "@/lib/db-discovery-core";
import { PROJECTS_ROOT } from "@/lib/signals";

const pexec = promisify(execFile);

/** A connection found on this box, and whether something answers on its port right now. */
export type Found = FoundConn & { running: boolean };

/** The dotenv files a project (or one of its apps) keeps its database URLs in. */
const ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".env.production", ".env.production.local"];

/** Every project's and app's env files (a project's folder and the folders right under it), with the name to show. */
async function envFiles(): Promise<{ file: string; rel: string; name: string }[]> {
  const root = path.resolve(PROJECTS_ROOT);
  const dirs: string[] = [];
  const subdirs = async (dir: string) =>
    (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => path.join(dir, e.name));
  for (const project of await subdirs(root)) dirs.push(project, ...(await subdirs(project)));
  const out: { file: string; rel: string; name: string }[] = [];
  for (const dir of dirs)
    for (const f of ENV_FILES) out.push({ file: path.join(dir, f), rel: path.relative(root, path.join(dir, f)), name: path.relative(root, dir) });
  return out;
}

/** The running containers, inspected (none when docker isn't there or doesn't answer). */
async function containers(): Promise<ContainerInfo[]> {
  try {
    const { stdout: ids } = await pexec("docker", ["ps", "-q", "--no-trunc"], { timeout: 5000 });
    const list = ids.split("\n").filter(Boolean);
    if (!list.length) return [];
    const { stdout } = await pexec("docker", ["inspect", ...list], { timeout: 8000, maxBuffer: 16 * 1024 * 1024 });
    type Inspect = {
      Name?: string;
      Config?: { Image?: string; Env?: string[] };
      HostConfig?: { NetworkMode?: string };
      NetworkSettings?: { Ports?: ContainerInfo["ports"]; Networks?: Record<string, { IPAddress?: string }> };
    };
    return (JSON.parse(stdout) as Inspect[]).map((c) => ({
      name: (c.Name ?? "").replace(/^\//, ""),
      image: c.Config?.Image ?? "",
      env: c.Config?.Env ?? [],
      ports: c.NetworkSettings?.Ports ?? {},
      ip: Object.values(c.NetworkSettings?.Networks ?? {}).find((n) => n.IPAddress)?.IPAddress ?? null,
      hostNetwork: c.HostConfig?.NetworkMode === "host",
    }));
  } catch {
    return [];
  }
}

/** Whether something accepts a connection on host:port (a database configured but not running doesn't). */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(800, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/**
 * Every database on this box the admin can name: the admin's own DATABASE_URL, the local ones in the projects' env
 * files, and the database containers (with what their env sets up), one connection per server and user.
 */
async function discover(): Promise<Found[]> {
  const list: { conn: NonNullable<ReturnType<typeof connFromUrl>>; name: string; from: string }[] = [];
  const own = process.env.DATABASE_URL && connFromUrl(process.env.DATABASE_URL);
  if (own) list.push({ conn: own, name: "This server", from: "the admin's DATABASE_URL" });
  for (const { file, rel, name } of await envFiles()) {
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) continue;
    for (const url of dbUrlsInEnv(text)) {
      const conn = connFromUrl(url);
      if (conn) list.push({ conn, name, from: rel });
    }
  }
  for (const c of await containers()) {
    const conn = connFromContainer(c);
    if (conn) list.push({ conn, name: c.name, from: `docker ${c.name}` });
  }
  const found = mergeFound(list);
  // (a project with two users on one server: each named for its user too)
  const named = new Map<string, number>();
  for (const f of found) named.set(f.name, (named.get(f.name) ?? 0) + 1);
  for (const f of found) if ((named.get(f.name) ?? 0) > 1) f.name = `${f.name} (${f.username})`;
  const up = await Promise.all(found.map((f) => answers(f.host, f.port)));
  return found.map((f, i) => ({ ...f, running: up[i] }));
}

const CACHE_MS = 30_000;
const g = globalThis as { __dbFound?: { at: number; p: Promise<Map<string, Found>> } };

/**
 * The databases found on this box, by key, and the explorer's connections brought in line with them (found once
 * per 30 s: every listing of the connections asks).
 */
export function foundConnections(): Promise<Map<string, Found>> {
  if (g.__dbFound && Date.now() - g.__dbFound.at < CACHE_MS) return g.__dbFound.p;
  const p = (async () => {
    const found = await discover();
    await syncFoundConnections(found);
    return new Map(found.map((f) => [f.key, f]));
  })();
  p.catch(() => (g.__dbFound = undefined));
  g.__dbFound = { at: Date.now(), p };
  return p;
}

/** Look again on the next listing (a connection was added, changed or removed by hand). */
export function forgetFound() {
  g.__dbFound = undefined;
}
