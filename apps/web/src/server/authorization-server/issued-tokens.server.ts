import { createLocalJWKSet, importJWK, jwtVerify, SignJWT, type JWK } from "jose";

import { USERINFO_ENDPOINT_PATH } from "#src/lib/oidc-paths";
import { sha256Digest } from "#src/server/auth/opaque-token.server";
import { publicJwks, SIGNING_ALGORITHM, type SigningKey } from "./signing-keys.server";

/** Access tokens and ID tokens live an hour; no refresh token is issued, so an app signs the
 * person in again after that. */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
const ID_TOKEN_TTL_SECONDS = 3600;

/** The issuer and its keys: the first key signs, every key verifies. */
export type TokenIssuer = { issuer: string; signingKeys: readonly SigningKey[] };

/** The access token's audience (RFC 9068 §3): the one resource that accepts it, UserInfo. */
function accessTokenAudience(issuer: string): string {
  return new URL(USERINFO_ENDPOINT_PATH, issuer).href;
}

/** An RFC 9068 JWT access token for the grant `grantId` (its `jti`). */
export async function mintAccessToken(
  { issuer, signingKeys }: TokenIssuer,
  grant: { grantId: string; userId: string; clientId: string; scopes: string[] },
  now: Date,
): Promise<string> {
  const issuedAt = epochSeconds(now);
  return new SignJWT({ client_id: grant.clientId, scope: grant.scopes.join(" ") })
    .setProtectedHeader(header(signingKeys, "at+jwt"))
    .setIssuer(issuer)
    .setSubject(grant.userId)
    .setAudience(accessTokenAudience(issuer))
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
    .setJti(grant.grantId)
    .sign(await privateKey(signingKeys));
}

/** An Agent's token for an app lives five minutes: it is asked for at each use. */
export const AGENT_TOKEN_TTL_SECONDS = 300;

/** An RFC 9068 JWT access token for the Agent `agentId` to call the app `appKey`: its audience is
 * the app (its client ID), and `type: "agent"` tells it from a person's. Each one has its own
 * `jti`. */
export async function mintAgentAccessToken(
  { issuer, signingKeys }: TokenIssuer,
  token: {
    agentId: string;
    appKey: string;
    workspaceId: string;
    workspaceSlug: string;
    scopes: readonly string[];
  },
  now: Date,
): Promise<string> {
  const issuedAt = epochSeconds(now);
  return new SignJWT({
    client_id: token.appKey,
    type: "agent",
    workspace_id: token.workspaceId,
    workspace_slug: token.workspaceSlug,
    scope: token.scopes.join(" "),
  })
    .setProtectedHeader(header(signingKeys, "at+jwt"))
    .setIssuer(issuer)
    .setSubject(token.agentId)
    .setAudience(token.appKey)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + AGENT_TOKEN_TTL_SECONDS)
    .setJti(crypto.randomUUID())
    .sign(await privateKey(signingKeys));
}

/** An OIDC Core §2 ID token for the app `clientId`, with `at_hash` binding `accessToken`
 * (§3.1.3.6). It carries no scope claims: with an access token issued, those are UserInfo's
 * (§5.4). */
export async function mintIdToken(
  { issuer, signingKeys }: TokenIssuer,
  token: {
    userId: string;
    clientId: string;
    authTime: Date;
    nonce?: string;
    accessToken: string;
  },
  now: Date,
): Promise<string> {
  const issuedAt = epochSeconds(now);
  return new SignJWT({
    auth_time: epochSeconds(token.authTime),
    ...(token.nonce ? { nonce: token.nonce } : {}),
    at_hash: sha256Digest(token.accessToken).subarray(0, 16).toString("base64url"),
  })
    .setProtectedHeader(header(signingKeys, "JWT"))
    .setIssuer(issuer)
    .setSubject(token.userId)
    .setAudience(token.clientId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ID_TOKEN_TTL_SECONDS)
    .sign(await privateKey(signingKeys));
}

/** What a verified access token names. */
export type VerifiedAccessToken = { grantId: string; userId: string };

/** The access token's grant, when `token` is an unexpired `at+jwt` this issuer signed for
 * UserInfo; `undefined` otherwise. */
export async function verifyAccessToken(
  { issuer, signingKeys }: TokenIssuer,
  token: string,
  now: Date,
): Promise<VerifiedAccessToken | undefined> {
  try {
    const { payload } = await jwtVerify(token, publishedKeys(signingKeys), {
      issuer,
      audience: accessTokenAudience(issuer),
      typ: "at+jwt",
      algorithms: [SIGNING_ALGORITHM],
      requiredClaims: ["sub", "jti", "exp", "iat", "client_id", "scope"],
      currentDate: now,
    });
    return { grantId: payload.jti!, userId: payload.sub! };
  } catch {
    return undefined;
  }
}

const epochSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

function header(signingKeys: readonly SigningKey[], typ: string) {
  return { alg: SIGNING_ALGORITHM, kid: currentKey(signingKeys).kid, typ };
}

function currentKey(signingKeys: readonly SigningKey[]): SigningKey {
  const [current] = signingKeys;
  if (!current) throw new Error("the authorization server has no signing key");
  return current;
}

const privateKeys = new WeakMap<SigningKey, ReturnType<typeof importJWK>>();
const publicKeySets = new WeakMap<readonly SigningKey[], ReturnType<typeof createLocalJWKSet>>();

/** The current key, imported once per configured key. */
function privateKey(signingKeys: readonly SigningKey[]) {
  const key = currentKey(signingKeys);
  let imported = privateKeys.get(key);
  if (!imported) {
    imported = importJWK(key, SIGNING_ALGORITHM);
    privateKeys.set(key, imported);
  }
  return imported;
}

/** Every configured key's public half, chosen by the token's `kid`. */
function publishedKeys(signingKeys: readonly SigningKey[]) {
  let keySet = publicKeySets.get(signingKeys);
  if (!keySet) {
    keySet = createLocalJWKSet(publicJwks(signingKeys) as { keys: JWK[] });
    publicKeySets.set(signingKeys, keySet);
  }
  return keySet;
}
