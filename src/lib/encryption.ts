/**
 * AES-256-GCM encryption for values that must be encrypted at rest
 * (CONTRACT.md §4: googleAccessToken, googleRefreshToken). Key comes from
 * the ENCRYPTION_KEY env var as a 64-character hex string (32 bytes).
 *
 * Ciphertext format: base64(iv[12 bytes] || authTag[16 bytes] || ciphertext).
 * Packing everything into one string matches the schema's single `text`
 * columns (see supabase/migrations/20260913140100_create_users.sql).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function loadKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error("Missing required environment variable: ENCRYPTION_KEY");
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes (a ${KEY_LENGTH * 2}-character hex string); got ${key.length} bytes`
    );
  }
  return key;
}

/** Encrypts a plaintext string, returning a single base64 ciphertext blob. */
export function encrypt(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/** Decrypts a ciphertext blob produced by `encrypt`. */
export function decrypt(ciphertext: string): string {
  const key = loadKey();
  const blob = Buffer.from(ciphertext, "base64");
  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Ciphertext is too short to contain an IV and auth tag");
  }
  const iv = blob.subarray(0, IV_LENGTH);
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
