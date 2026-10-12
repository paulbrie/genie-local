import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { techOf } from "./tech";

const port = (port: number, proto: "tcp" | "udp", service = "", process: string | null = null, tech?: { name: string }) => ({ port, proto, service, process, ...(tech ? { tech } : {}) });

describe("a public port's technology (T217)", () => {
  it("by its process first, whatever the port", () => {
    assert.deepEqual(
      [port(22, "tcp", "ssh", "sshd"), port(3000, "tcp", "", "nginx"), port(7000, "tcp", "next-server", "next-server"), port(8080, "tcp", "", "node"), port(5432, "tcp", "postgres", "postgres"), port(5544, "tcp", "", "docker-proxy"), port(8000, "tcp", "", "python3.12"), port(443, "tcp", "https", "caddy"), port(80, "tcp", "http", "apache2"), port(81, "tcp", "", "httpd"), port(6379, "tcp", "", "redis-server")].map((p) => techOf(p)?.id),
      ["openssh", "nginx", "next", "node", "postgres", "docker", "python", "caddy", "apache", "apache", "redis"],
    );
  });
  it("no readable process: the stats side's hint, then 22, 80/443 and 68/udp only", () => {
    assert.equal(techOf(port(3000, "tcp", "", null, { name: "nginx" }))?.id, "nginx");
    assert.equal(techOf(port(5544, "tcp", "", null, { name: "postgres" }))?.id, "postgres");
    // (T218's live answers: systemd's ssh, nginx's 80, docker's postgres image, the port's dhcp)
    assert.deepEqual([port(22, "tcp", "ssh", null, { name: "ssh" }), port(80, "tcp", "http", null, { name: "nginx" }), port(68, "udp", "dhcp", null, { name: "dhcp" })].map((p) => techOf(p)?.id), ["openssh", "nginx", "dhcp"]);
    assert.deepEqual([port(22, "tcp", "ssh"), port(80, "tcp", "http"), port(443, "tcp", "https"), port(68, "udp", "dhcp")].map((p) => techOf(p)?.id), ["ssh", "web", "web", "dhcp"]);
  });
  it("never a guess beyond that: an unknown process, a port number alone, an unknown hint: none", () => {
    assert.deepEqual([port(3000, "tcp"), port(5544, "tcp"), port(5432, "tcp", "postgres"), port(9000, "tcp", "", "mystery"), port(68, "tcp"), port(22, "udp"), port(1234, "tcp", "", null, { name: "who-knows" })].map((p) => techOf(p)), [null, null, null, null, null, null, null]);
  });
});
