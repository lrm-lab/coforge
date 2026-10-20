import { importJWK, type JWK } from "jose";
import { AuthorizationServerConfigError } from "./configuration-error.server";

/** The one algorithm this issuer signs with. */
export const SIGNING_ALGORITHM = "ES256";

/** A configured private EC P-256 signing key with its `kid`. */
export type SigningKey = JWK & { kid: string };

/** A private JWK Set (`{"keys":[...]}`) of EC P-256 signing keys, each with a unique `kid`, and
 * `alg`, `use` and `key_ops` either absent or saying ES256 signing. Order is kept: the first key
 * signs, and every key stays published so a rotated-out key keeps verifying what it signed. */
export async function parseSigningKeys(value: string): Promise<SigningKey[]> {
  let keyset: unknown;
  try {
    keyset = JSON.parse(value);
  } catch {
    throw new AuthorizationServerConfigError("COFORGE_OIDC_SIGNING_JWKS must be JSON");
  }
  const keys = isRecord(keyset) ? keyset.keys : undefined;
  if (!Array.isArray(keys) || keys.length === 0)
    throw new AuthorizationServerConfigError(
      'COFORGE_OIDC_SIGNING_JWKS must be a JWK Set {"keys":[...]} with at least one key',
    );

  const signingKeys: SigningKey[] = [];
  for (const [index, jwk] of keys.entries()) {
    const signingKey = await parseSigningKey(jwk, index);
    if (signingKeys.some(({ kid }) => kid === signingKey.kid))
      throw new AuthorizationServerConfigError(
        `COFORGE_OIDC_SIGNING_JWKS key ${index} repeats another key's kid`,
      );
    signingKeys.push(signingKey);
  }
  return signingKeys;
}

async function parseSigningKey(jwk: unknown, index: number): Promise<SigningKey> {
  const invalid = (problem: string) =>
    new AuthorizationServerConfigError(`COFORGE_OIDC_SIGNING_JWKS key ${index} ${problem}`);
  if (!isRecord(jwk)) throw invalid("is not a JWK");
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") throw invalid("is not an EC P-256 key");
  if (typeof jwk.d !== "string" || !jwk.d) throw invalid("is not a private key");
  if (typeof jwk.kid !== "string" || !jwk.kid) throw invalid("has no kid");
  if (jwk.alg !== undefined && jwk.alg !== SIGNING_ALGORITHM) throw invalid("is not for ES256");
  // RFC 7517 §4.2-4.3: a key restricted to another use must not sign.
  if (jwk.use !== undefined && jwk.use !== "sig") throw invalid("is not for signatures");
  if (jwk.key_ops !== undefined && !(Array.isArray(jwk.key_ops) && jwk.key_ops.includes("sign")))
    throw invalid("is not for signing");
  // Importing proves the members form a usable private key.
  try {
    await importJWK(jwk as JWK, SIGNING_ALGORITHM);
  } catch {
    throw invalid("is not a usable ES256 private key");
  }
  return jwk as SigningKey;
}

/** The public half of each key, built from an allowlist of public EC members so that no private
 * member (`d`, or any other the configuration carried) can reach the published set. */
export function publicJwks(keys: readonly SigningKey[]): { keys: JWK[] } {
  return {
    keys: keys.map(({ kty, crv, x, y, kid }) => ({
      kty,
      crv,
      x,
      y,
      kid,
      alg: SIGNING_ALGORITHM,
      use: "sig",
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
