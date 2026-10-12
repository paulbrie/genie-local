/**
 * Which technology listens on a public port (T217), for its box on the gateway: from the listening process's name
 * when it's readable, else from a few well-known ports, else nothing (a plain box with its number). Pure; it never
 * guesses beyond that: a port's number alone says nothing about what serves it (5544 is Postgres in Docker here).
 */

export type TechIcon = "terminal" | "nginx" | "next" | "node" | "postgres" | "docker" | "python" | "caddy" | "apache" | "redis" | "globe" | "network";
export type Tech = { id: string; name: string; icon: TechIcon; /** its mark's colour on the dark box */ color: string };

const T = {
  openssh: { id: "openssh", name: "OpenSSH", icon: "terminal", color: "#e2e8f0" },
  ssh: { id: "ssh", name: "SSH", icon: "terminal", color: "#cbd5e1" },
  nginx: { id: "nginx", name: "nginx", icon: "nginx", color: "#22c55e" },
  next: { id: "next", name: "Next.js", icon: "next", color: "#f8fafc" },
  node: { id: "node", name: "Node.js", icon: "node", color: "#84cc16" },
  postgres: { id: "postgres", name: "PostgreSQL", icon: "postgres", color: "#60a5fa" },
  docker: { id: "docker", name: "Docker", icon: "docker", color: "#38bdf8" },
  python: { id: "python", name: "Python", icon: "python", color: "#facc15" },
  caddy: { id: "caddy", name: "Caddy", icon: "caddy", color: "#34d399" },
  apache: { id: "apache", name: "Apache", icon: "apache", color: "#f472b6" },
  redis: { id: "redis", name: "Redis", icon: "redis", color: "#f87171" },
  web: { id: "web", name: "Web", icon: "globe", color: "#93c5fd" },
  dhcp: { id: "dhcp", name: "DHCP", icon: "network", color: "#c4b5fd" },
} as const satisfies Record<string, Tech>;

/** the process names known, by their start (lower case) */
const BY_PROCESS: [RegExp, Tech][] = [
  [/^sshd\b/, T.openssh],
  [/^nginx\b/, T.nginx],
  [/^(next-server|next)\b/, T.next],
  [/^(node|nodejs)\b/, T.node],
  [/^(postgres|postmaster)\b/, T.postgres],
  [/^(docker-proxy|dockerd)\b/, T.docker],
  [/^python[\d.]*\b/, T.python],
  [/^caddy\b/, T.caddy],
  [/^(apache2|httpd)\b/, T.apache],
  [/^redis-server\b/, T.redis],
];

/** the names the stats side may give as a port's tech hint (systemd, docker, nginx's config: T211's follow-up) */
const BY_HINT: Record<string, Tech> = { ssh: T.openssh, openssh: T.openssh, nginx: T.nginx, next: T.next, "next.js": T.next, node: T.node, postgres: T.postgres, postgresql: T.postgres, docker: T.docker, python: T.python, caddy: T.caddy, apache: T.apache, redis: T.redis, http: T.web, https: T.web, dhcp: T.dhcp };

/**
 * A public port's technology: its process first; then the stats side's hint, if it gives one (from systemd, docker or
 * nginx's config, read without root); then 22 (ssh), 80/443 (the web) and 68/udp (dhcp); else null.
 */
export function techOf(p: { port: number; proto: "tcp" | "udp"; service: string; process: string | null; tech?: { name: string } | null }): Tech | null {
  const proc = p.process?.trim().toLowerCase();
  if (proc) for (const [re, t] of BY_PROCESS) if (re.test(proc)) return t;
  const hint = p.tech?.name?.trim().toLowerCase();
  if (hint && BY_HINT[hint]) return BY_HINT[hint];
  if (p.proto === "tcp" && p.port === 22) return T.ssh;
  if (p.proto === "tcp" && (p.port === 80 || p.port === 443)) return T.web;
  if (p.proto === "udp" && p.port === 68) return T.dhcp;
  return null;
}
