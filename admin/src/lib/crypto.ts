import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

/**
 * AES-256-GCM encryption for connection passwords at rest. Key comes from
 * APP_ENC_KEY (32 bytes, base64 or hex) in .env.local. Output format:
 *   v1:<iv b64>:<authTag b64>:<ciphertext b64>
 */
const KEY_B64 = process.env.APP_ENC_KEY;

function key(): Buffer {
  if (!KEY_B64) throw new Error("APP_ENC_KEY is not set (see .env.local)");
  // 32 bytes, base64- or hex-encoded (the installer writes 64 hex characters, which base64 would read as 48 bytes).
  const k = /^[0-9a-f]{64}$/i.test(KEY_B64) ? Buffer.from(KEY_B64, "hex") : Buffer.from(KEY_B64, "base64");
  if (k.length !== 32) {
    throw new Error("APP_ENC_KEY must be 32 bytes (base64- or hex-encoded)");
  }
  return k;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decrypt(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("malformed encrypted value");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
