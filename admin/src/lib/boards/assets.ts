import "server-only";

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { ASSET_PREFIX } from "@/lib/boards/core.mjs";

/**
 * Images pasted or dropped on a board live on disk, one folder per board:
 * <root>/<boardId>/<random>.<ext>, served by /api/boards/assets/<boardId>/<file>.
 * Only raster images: nothing that could run script on the admin origin.
 */
export const BOARD_ASSETS_ROOT = path.resolve(
  process.env.BOARD_ASSETS_DIR ?? "/opt/project/.board-assets",
);
export const MAX_ASSET_BYTES = 15 * 1024 * 1024;

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));

const FILE_RE = /^[a-f0-9]{16}\.(png|jpg|gif|webp|avif)$/;

export async function saveBoardAsset(boardId: number, file: File) {
  const ext = EXT[file.type];
  if (!ext) throw new Error("Only PNG, JPEG, GIF, WebP or AVIF images");
  if (file.size > MAX_ASSET_BYTES) throw new Error(`Images are limited to ${MAX_ASSET_BYTES / 1024 / 1024} MB`);
  const name = `${randomBytes(8).toString("hex")}.${ext}`;
  const dir = path.join(BOARD_ASSETS_ROOT, String(boardId));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), Buffer.from(await file.arrayBuffer()));
  return { src: `${ASSET_PREFIX}${boardId}/${name}` };
}

/** The file and its type, or null for anything that isn't one of ours. */
export function boardAssetPath(board: string, file: string) {
  if (!/^\d{1,10}$/.test(board) || !FILE_RE.test(file)) return null;
  return {
    abs: path.join(BOARD_ASSETS_ROOT, board, file),
    mime: MIME[file.split(".").pop()!],
  };
}
