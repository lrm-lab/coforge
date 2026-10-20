import { mintOpaqueToken, sha256Hex } from "#src/server/auth/opaque-token.server";

/** An authorization code lives ten minutes (RFC 6749 §4.1.2 recommends at most ten). */
export const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;

/** An authorization code as it is stored: its hash, never the code, with everything the token
 * endpoint checks the redemption against. */
export type StoredAuthorizationCode = {
  codeHash: string;
  appId: string;
  userId: string;
  workspaceId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce?: string;
  scopes: string[];
  /** When the person last signed in (OIDC `auth_time`). */
  authTime: Date;
  expiresAt: Date;
};

/** SHA-256 (hex) of a code: the stored form, and the key a redemption looks up. */
export function hashAuthorizationCode(code: string): string {
  return sha256Hex(code);
}

/** A new code: 256 bits from the CSPRNG, base64url (RFC 6749 §10.10), and its hash. */
export function mintAuthorizationCode(): { code: string; codeHash: string } {
  const code = mintOpaqueToken();
  return { code, codeHash: hashAuthorizationCode(code) };
}
