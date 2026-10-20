import { randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes, base64url, behind a prefix that says what the string is when it leaks. */
const APP_CLIENT_SECRET = /^cfa_secret_[A-Za-z0-9_-]{43}$/;

export function hashAppClientSecret(secret: string): string {
  return new Bun.CryptoHasher("sha256").update(secret).digest("hex");
}

/** A new client secret and the hash that is all the registry stores of it. */
export function mintAppClientSecret(): { secret: string; hash: string } {
  const secret = `cfa_secret_${randomBytes(32).toString("base64url")}`;
  return { secret, hash: hashAppClientSecret(secret) };
}

/** Whether `presented` is the secret `storedHash` was made from, compared in constant time. */
export function appClientSecretMatches(storedHash: string, presented: string): boolean {
  if (!APP_CLIENT_SECRET.test(presented)) return false;
  const expected = Buffer.from(storedHash);
  const actual = Buffer.from(hashAppClientSecret(presented));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
