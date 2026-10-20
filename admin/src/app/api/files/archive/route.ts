// GET /api/files/archive?path=<folder>: the folder as a .tar.gz, streamed from `tar` (never built in memory or on
// disk). Credential files are left out by the same rules the listing flags them with (isSecretPath): a folder download
// mustn't carry out what a single download needs a confirm for. Rebuildable bulk (node_modules, Next build dirs,
// caches) is left out too. Every archive is in the audit log.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";

import { isPseudo, resolveExisting } from "@/lib/files/guard";
import { audit } from "@/lib/files/ops";
import { errorResponse, whoOf } from "../shared";

export const dynamic = "force-dynamic";

// GNU tar patterns (any depth, case-insensitive): the credential names and folders of lib/files/listing.ts …
const SECRET_EXCLUDES = [
  ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "*.kdbx", "*.ppk", "*.asc", "*.gpg",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".netrc", ".pgpass", ".npmrc", ".pypirc", ".git-credentials",
  ".htpasswd", ".dockercfg", "credentials", "credentials.json", ".credentials", ".credentials.json",
  "secret.json", "secrets.json", "secret.yml", "secrets.yml", "secret.yaml", "secrets.yaml", "secret.toml",
  "secrets.toml", "secret.env", "secrets.env", "service-account*.json", ".ssh", ".gnupg", ".aws", ".docker",
];
// … and what any project rebuilds.
const BULK_EXCLUDES = ["node_modules", ".next", ".next-*", ".turbo", ".cache"];

export async function GET(req: NextRequest) {
  try {
    const t = await resolveExisting(req.nextUrl.searchParams.get("path") ?? "");
    if (isPseudo(t.abs)) return NextResponse.json({ error: "a kernel folder (/proc, /sys): not archived" }, { status: 403 });
    if (!(await fs.stat(t.abs)).isDirectory()) return NextResponse.json({ error: "not a folder" }, { status: 400 });
    const parent = path.dirname(t.abs), name = path.basename(t.abs) || "root";

    const tar = spawn(
      "tar",
      [
        "-czf", "-", "--ignore-case", "--warning=no-file-changed", "--warning=no-file-removed",
        ...[...SECRET_EXCLUDES, ...BULK_EXCLUDES].map((p) => `--exclude=${p}`),
        "-C", parent, path.basename(t.abs) || ".",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    // A cancelled download stops tar.
    req.signal.addEventListener("abort", () => tar.kill("SIGTERM"));
    audit("download-folder", { path: t.abs, excludes: "credentials, node_modules, build dirs" }, whoOf(req));

    return new Response(Readable.toWeb(tar.stdout) as ReadableStream, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${name}.tar.gz`)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
