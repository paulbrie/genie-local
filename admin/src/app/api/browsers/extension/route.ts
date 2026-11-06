import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32 } from "node:zlib";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { BASE_PATH } from "@/lib/config";

export const dynamic = "force-dynamic";

const EXT_DIR = join(process.cwd(), "extension");

/** A zip (stored, no compression: it's a few small files) of `files`. */
function zip(files: { name: string; data: Buffer }[]): Buffer {
  // Every entry dated now, in DOS form (a zeroed date reads as 1980-00-00, which some unzippers reject).
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, f.data);
    centrals.push(central, name);
    offset += local.length + name.length + f.data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/**
 * The Spiridus Bridge extension as a zip, its config.js pointing at this
 * Spiridus (the address this was downloaded from), ready for chrome://extensions
 * → Developer mode → Load unpacked.
 */
export async function GET(req: NextRequest) {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("127.0.0.1") || host.startsWith("localhost") ? "http" : "https");
  const server = `${proto}://${host}${BASE_PATH}`;
  const files = [];
  for (const name of (await readdir(EXT_DIR)).sort()) {
    let data = await readFile(join(EXT_DIR, name));
    if (name === "config.js") data = Buffer.from(`// Written by the download on ${server}/browsers; the popup can change it.\nexport const DEFAULT_SERVER = ${JSON.stringify(server)};\n`);
    files.push({ name: `spiridus-bridge/${name}`, data });
  }
  return new NextResponse(new Uint8Array(zip(files)), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="spiridus-bridge.zip"',
      "Cache-Control": "no-store",
    },
  });
}
