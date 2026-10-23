import { mintOpaqueToken, sha256Hex } from "#src/server/auth/opaque-token.server";

/** SHA-256 (hex) of a share token: the only form of it that is stored, and the key an install
 * looks the link up by. */
export function hashShareToken(token: string): string {
  return sha256Hex(token);
}

/** A new share token (256 bits, behind a prefix that says what it is when it leaks) and its hash. */
export function mintShareToken(): { token: string; hash: string } {
  const token = `cfa_share_${mintOpaqueToken()}`;
  return { token, hash: hashShareToken(token) };
}
