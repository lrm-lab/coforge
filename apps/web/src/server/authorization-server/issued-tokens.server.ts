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
  return signAccessToken(
    { issuer, signingKeys },
    { client_id: grant.clientId, scope: grant.scopes.join(" ") },
    {
      subject: grant.userId,
      audience: accessTokenAudience(issuer),
      ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
      jti: grant.grantId,
    },
    now,
  );
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
  return signAccessToken(
    { issuer, signingKeys },
    {
      client_id: token.appKey,
      type: "agent",
      workspace_id: token.workspaceId,
      workspace_slug: token.workspaceSlug,
      scope: token.scopes.join(" "),
    },
    {
      subject: token.agentId,
      audience: token.appKey,
      ttlSeconds: AGENT_TOKEN_TTL_SECONDS,
      jti: crypto.randomUUID(),
    },
    now,
  );
}

/** An installation token lives ten minutes: an app asks for a new one when it needs one. */
export const INSTALLATION_TOKEN_TTL_SECONDS = 600;

/** What an installation token names (`type: "installation"`). */
export type InstallationTokenClaims = {
  appKey: string;
  installationId: string;
  workspaceId: string;
  scope: string;
};

/** An RFC 9068 JWT access token for the app `claims.appKey` (its `sub` and `client_id`, RFC 9068
 * §2.2) to read its installation: `audience` is the installation's resource URI. Each one has its
 * own `jti`. */
export async function mintInstallationAccessToken(
  { issuer, signingKeys }: TokenIssuer,
  claims: InstallationTokenClaims,
  audience: string,
  now: Date,
): Promise<string> {
  return signAccessToken(
    { issuer, signingKeys },
    {
      client_id: claims.appKey,
      type: "installation",
      installation_id: claims.installationId,
      workspace_id: claims.workspaceId,
      scope: claims.scope,
    },
    {
      subject: claims.appKey,
      audience,
      ttlSeconds: INSTALLATION_TOKEN_TTL_SECONDS,
      jti: crypto.randomUUID(),
    },
    now,
  );
}

/** The claims of an unexpired `at+jwt` this issuer signed for `audience` as an installation token;
 * `undefined` otherwise. The installation itself is not consulted here. */
export async function verifyInstallationAccessToken(
  { issuer, signingKeys }: TokenIssuer,
  token: string,
  audience: string,
  now: Date,
): Promise<(InstallationTokenClaims & { subject: string }) | undefined> {
  const payload = await verifyAccessJwt(
    { issuer, signingKeys },
    token,
    audience,
    ["client_id", "scope", "installation_id"],
    now,
  );
  if (!payload) return undefined;
  const { client_id, type, installation_id, workspace_id, scope } = payload;
  if (
    type !== "installation" ||
    typeof client_id !== "string" ||
    typeof installation_id !== "string" ||
    typeof workspace_id !== "string" ||
    typeof scope !== "string"
  )
    return undefined;
  return {
    subject: payload.sub!,
    appKey: client_id,
    installationId: installation_id,
    workspaceId: workspace_id,
    scope,
  };
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
  const payload = await verifyAccessJwt(
    { issuer, signingKeys },
    token,
    accessTokenAudience(issuer),
    ["client_id", "scope"],
    now,
  );
  return payload && { grantId: payload.jti!, userId: payload.sub! };
}

/** An `at+jwt` signed by the current key: `claims` plus the issuer, `subject`, `audience`, issue
 * and expiry times, and `jti`. */
async function signAccessToken(
  { issuer, signingKeys }: TokenIssuer,
  claims: Record<string, string>,
  token: { subject: string; audience: string; ttlSeconds: number; jti: string },
  now: Date,
): Promise<string> {
  const issuedAt = epochSeconds(now);
  return new SignJWT(claims)
    .setProtectedHeader(header(signingKeys, "at+jwt"))
    .setIssuer(issuer)
    .setSubject(token.subject)
    .setAudience(token.audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + token.ttlSeconds)
    .setJti(token.jti)
    .sign(await privateKey(signingKeys));
}

/** The payload of an unexpired `at+jwt` this issuer signed for `audience`, carrying `sub`, `jti`,
 * `exp`, `iat` and `extraClaims`; `undefined` otherwise. */
async function verifyAccessJwt(
  { issuer, signingKeys }: TokenIssuer,
  token: string,
  audience: string,
  extraClaims: string[],
  now: Date,
) {
  try {
    const { payload } = await jwtVerify(token, publishedKeys(signingKeys), {
      issuer,
      audience,
      typ: "at+jwt",
      algorithms: [SIGNING_ALGORITHM],
      requiredClaims: ["sub", "jti", "exp", "iat", ...extraClaims],
      currentDate: now,
    });
    return payload;
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
