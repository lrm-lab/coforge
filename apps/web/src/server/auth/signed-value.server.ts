import { createHmac, timingSafeEqual } from "node:crypto";

import { utf8Decoder, utf8Encoder } from "@lrm/coforge-sdk/internal";

/**
 * What a signed value is for. It is part of what the signature covers, so one value never reads
 * as another's: all are signed with the same session secret, and without it a sign-in state cookie
 * replayed as `coforge_session` would pass as a session.
 */
type SignedPurpose =
  | "session"
  | "login-state"
  | "logout-return"
  | "authorization-request"
  | "authorization-query"
  | "sign-in-requested";

/** `payload` as JSON, base64url, then `.` and its HMAC-SHA256 under `secret` for `purpose`. */
export function signValue(purpose: SignedPurpose, payload: object, secret: string): string {
  const body = Buffer.from(utf8Encoder.encode(JSON.stringify(payload))).toString("base64url");
  return `${body}.${hmacSha256(secret, `${purpose}.${body}`)}`;
}

/** The payload `signValue` signed for `purpose`, or null when `value` is missing, malformed or
 * not signed for it. Expiry is the caller's to judge. */
export function readSignedValue<T>(
  purpose: SignedPurpose,
  value: string | null | undefined,
  secret: string,
): T | null {
  if (!value) return null;
  const [body, signature, ...rest] = value.split(".");
  if (!body || !signature || rest.length > 0) return null;
  const expected = utf8Encoder.encode(hmacSha256(secret, `${purpose}.${body}`));
  const given = utf8Encoder.encode(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    return JSON.parse(utf8Decoder.decode(new Uint8Array(Buffer.from(body, "base64url")))) as T;
  } catch {
    return null;
  }
}

/** `node:crypto`, not `Bun.CryptoHasher`: Bun 1.4.3's HMAC constructor throws an error a failed Web
 * Crypto key import left on the thread's OpenSSL queue (`test/authentication-tests/signed-value`). */
function hmacSha256(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("base64url");
}
