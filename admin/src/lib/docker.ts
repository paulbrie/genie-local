import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

const DOCKER = "docker";
// Docker commands can be slow (stop waits for the grace period); give room but
// stay bounded. Buffers hold `docker ps`/`images` output for many objects.
const EXEC_OPTS = { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 } as const;

export type DockerContainer = {
  id: string;
  name: string;
  image: string;
  state: string; // running | exited | paused | created | restarting | dead
  status: string; // human string, e.g. "Up 3 hours"
  ports: string;
  createdAt: string;
};

export type DockerImage = {
  id: string;
  repository: string;
  tag: string;
  size: string;
  createdAt: string;
};

export type DockerSnapshot = {
  ts: number;
  available: boolean;
  error?: string;
  containers: DockerContainer[];
  images: DockerImage[];
};

export const CONTAINER_ACTIONS = [
  "start",
  "stop",
  "restart",
  "remove",
] as const;
export type ContainerAction = (typeof CONTAINER_ACTIONS)[number];

export const IMAGE_ACTIONS = ["remove"] as const;
export type ImageAction = (typeof IMAGE_ACTIONS)[number];

export function isContainerAction(v: unknown): v is ContainerAction {
  return (
    typeof v === "string" &&
    (CONTAINER_ACTIONS as readonly string[]).includes(v)
  );
}
export function isImageAction(v: unknown): v is ImageAction {
  return (
    typeof v === "string" && (IMAGE_ACTIONS as readonly string[]).includes(v)
  );
}

/**
 * Container/image IDs are validated as hex (short 12 or full 64), optionally
 * `sha256:`-prefixed for images. This is the only value we ever pass to the
 * docker CLI as a target, and it never reaches a shell (execFile), but keeping
 * the target to a strict charset is defense-in-depth against a poisoned name.
 */
const ID_RE = /^(sha256:)?[a-f0-9]{12,64}$/;
export function isDockerId(v: unknown): v is string {
  return typeof v === "string" && ID_RE.test(v);
}

export type DockerActionResult = { ok: boolean; output?: string; error?: string };

function parseJsonLines(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

const str = (o: Record<string, unknown>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v !== "") return v;
  }
  return "";
};

/** Extract a useful message from an execFile rejection (prefers stderr). */
function cleanErr(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  const s = (err.stderr || err.message || String(e)).trim();
  return s.split("\n").slice(0, 3).join(" ").slice(0, 500);
}

function toContainer(o: Record<string, unknown>): DockerContainer {
  return {
    id: str(o, "ID", "Id"),
    name: str(o, "Names", "Name"),
    image: str(o, "Image"),
    state: str(o, "State").toLowerCase(),
    status: str(o, "Status"),
    ports: str(o, "Ports"),
    createdAt: str(o, "CreatedAt"),
  };
}

function toImage(o: Record<string, unknown>): DockerImage {
  return {
    id: str(o, "ID", "Id"),
    repository: str(o, "Repository"),
    tag: str(o, "Tag"),
    size: str(o, "Size"),
    createdAt: str(o, "CreatedAt"),
  };
}

/** List all containers (running + stopped) and images. Never throws. */
export async function listDocker(): Promise<DockerSnapshot> {
  const ts = Date.now();
  try {
    const [ps, imgs] = await Promise.all([
      pexec(
        DOCKER,
        ["ps", "-a", "--no-trunc", "--format", "{{json .}}"],
        EXEC_OPTS,
      ),
      pexec(DOCKER, ["images", "--format", "{{json .}}"], EXEC_OPTS),
    ]);
    const containers = parseJsonLines(ps.stdout)
      .map(toContainer)
      .filter((c) => c.id);
    const images = parseJsonLines(imgs.stdout)
      .map(toImage)
      .filter((i) => i.id);
    return { ts, available: true, containers, images };
  } catch (e) {
    return {
      ts,
      available: false,
      error: cleanErr(e),
      containers: [],
      images: [],
    };
  }
}

const CONTAINER_ARGS: Record<ContainerAction, string[]> = {
  start: ["start"],
  stop: ["stop"],
  restart: ["restart"],
  // -f so a running container can be removed in one step; the UI confirms first.
  remove: ["rm", "-f"],
};

export async function runContainerAction(
  id: string,
  action: ContainerAction,
): Promise<DockerActionResult> {
  if (!isDockerId(id)) return { ok: false, error: "invalid container id" };
  try {
    const { stdout } = await pexec(
      DOCKER,
      [...CONTAINER_ARGS[action], id],
      EXEC_OPTS,
    );
    return { ok: true, output: stdout.trim() };
  } catch (e) {
    return { ok: false, error: cleanErr(e) };
  }
}

export async function runImageAction(
  id: string,
  action: ImageAction,
): Promise<DockerActionResult> {
  if (!isDockerId(id)) return { ok: false, error: "invalid image id" };
  // Only `remove` today. `rmi` refuses images still used by a container, which
  // is the safe default — surface that error rather than forcing.
  try {
    const { stdout } = await pexec(DOCKER, ["rmi", id], EXEC_OPTS);
    return { ok: true, output: stdout.trim() };
  } catch (e) {
    return { ok: false, error: cleanErr(e) };
  }
}

/** Tail of a container's logs (stdout+stderr combined), newest lines last. */
export async function containerLogs(
  id: string,
  tail = 500,
): Promise<{ ok: boolean; logs?: string; error?: string }> {
  if (!isDockerId(id)) return { ok: false, error: "invalid container id" };
  const n = Math.min(Math.max(Math.trunc(tail), 1), 5000);
  try {
    // docker writes logs to stderr for many images; merge both streams.
    const { stdout, stderr } = await pexec(
      DOCKER,
      ["logs", "--tail", String(n), "--timestamps", id],
      EXEC_OPTS,
    );
    return { ok: true, logs: `${stderr}${stdout}`.trimEnd() };
  } catch (e) {
    return { ok: false, error: cleanErr(e) };
  }
}
