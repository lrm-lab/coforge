import { createHash, randomBytes } from "node:crypto";

/** 32 bytes from the CSPRNG, base64url (43 characters): the random part of every secret token the
 * server mints (client secrets, daemon API keys, authorization codes). */
export function mintOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 of a string's UTF-8 bytes. */
export function sha256Digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** SHA-256 (hex): the form in which a minted token is stored and looked up. */
export function sha256Hex(value: string): string {
  return sha256Digest(value).toString("hex");
}
