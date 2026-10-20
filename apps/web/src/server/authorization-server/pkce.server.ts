import { timingSafeEqual } from "node:crypto";

import { sha256Digest } from "#src/server/auth/opaque-token.server";

/** RFC 7636 §4.1: 43 to 128 unreserved characters. */
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** RFC 7636 §4.6: whether `verifier` is well formed and its S256 transform is `challenge`. */
export function verifierMatchesChallenge(verifier: string | null, challenge: string): boolean {
  if (verifier === null || !CODE_VERIFIER.test(verifier)) return false;
  const expected = Buffer.from(challenge);
  const actual = Buffer.from(sha256Digest(verifier).toString("base64url"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
