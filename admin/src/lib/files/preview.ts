// The file explorer's preview, a page at a time (T243c): any file, any size. Text comes in pages that end on a whole
// UTF-8 character; a binary file (a NUL in its first 8 KB) as a hex dump. The page asks for the next page as needed.

import { promises as fs } from "node:fs";

/** bytes per page: text, and binary (a hex dump is ~4.3x its bytes) */
export const TEXT_PAGE = 1024 * 1024;
export const HEX_PAGE = 64 * 1024;

export interface PreviewPage {
  mode: "text" | "hex";
  text: string;
  size: number;
  /** where this page starts and where the next one does (= size at the end) */
  offset: number;
  next: number;
}

/** how many bytes of `buf` end on a whole UTF-8 character (an incomplete one at the end is left for the next page) */
export function utf8Boundary(buf: Buffer): number {
  for (let back = 1; back <= Math.min(4, buf.length); back++) {
    const b = buf[buf.length - back];
    if ((b & 0xc0) === 0x80) continue; // a continuation byte: keep looking for its lead
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? buf.length - back : buf.length;
  }
  return buf.length; // (not UTF-8 at the end: cut where it is)
}

/** a classic hex dump: offset, 16 bytes in hex, and the printable ones */
export function hexDump(buf: Buffer, start: number): string {
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i += 16) {
    const row = buf.subarray(i, i + 16);
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0"));
    const left = hex.slice(0, 8).join(" "), right = hex.slice(8).join(" ");
    const ascii = [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${(start + i).toString(16).padStart(8, "0")}  ${left.padEnd(23)}  ${right.padEnd(23)}  |${ascii}|`);
  }
  return lines.join("\n");
}

/** a page of `abs` from `offset`; `mode` decided by the first page (a NUL in the first 8 KB: hex) unless given */
export async function readPage(abs: string, offset: number, mode?: "text" | "hex"): Promise<PreviewPage> {
  const fh = await fs.open(abs, "r");
  try {
    const size = (await fh.stat()).size;
    const from = Math.max(0, Math.min(offset, size));
    if (!mode) {
      const head = Buffer.alloc(Math.min(size, 8192));
      await fh.read(head, 0, head.length, 0);
      mode = head.includes(0) ? "hex" : "text";
    }
    const buf = Buffer.alloc(Math.min(size - from, mode === "hex" ? HEX_PAGE : TEXT_PAGE));
    const { bytesRead } = await fh.read(buf, 0, buf.length, from);
    const got = buf.subarray(0, bytesRead);
    if (mode === "hex") return { mode, text: hexDump(got, from), size, offset: from, next: from + got.length };
    const atEnd = from + got.length >= size;
    const keep = atEnd ? got.length : utf8Boundary(got) || got.length;
    return { mode, text: got.subarray(0, keep).toString("utf8"), size, offset: from, next: from + keep };
  } finally {
    await fh.close();
  }
}
