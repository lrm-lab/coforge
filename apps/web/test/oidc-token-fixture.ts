import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, type JWK } from "jose";

import { NO_RATE_LIMIT } from "#src/server/app-rate-limits/app-rate-limit.server";
import { mintAppClientSecret } from "#src/server/apps/app-client-secret.server";
import { mintAuthorizationCode } from "#src/server/authorization-server/authorization-codes.server";
import { publicJwks, type SigningKey } from "#src/server/authorization-server/signing-keys.server";
import type { StoredAuthorizationCode } from "#src/server/authorization-server/authorization-codes.server";
import type { GrantStore, GrantSubject } from "#src/server/authorization-server/grants.server";
import { InstallationTokens } from "#src/server/authorization-server/installation-tokens.server";
import { TokenEndpoint } from "#src/server/authorization-server/token-endpoint.server";
import { UserInfoEndpoint } from "#src/server/authorization-server/userinfo-endpoint.server";

/** An app, a person in one Workspace, and the token and UserInfo endpoints over an in-memory
 * store, shared by their tests. */

export const ISSUER = "https://coforge.example/oidc";
export const NOW = new Date("2026-10-20T08:00:00.000Z");
export const NOW_SECONDS = NOW.getTime() / 1000;
export const REDIRECT_URI = "https://notes.acme.example/cb";
/** RFC 7636 Appendix B: this verifier's S256 challenge is `CHALLENGE`. */
export const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
export const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const CLIENT_SECRET = mintAppClientSecret();
export const CLIENT = {
  id: "app-1",
  key: "acme-notes",
  secret: CLIENT_SECRET.secret,
  clientSecretHash: CLIENT_SECRET.hash,
};
export const OTHER_CLIENT = { id: "app-2", key: "other-app", clientSecretHash: "x" };

async function signingKey(kid: string): Promise<SigningKey> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return { ...(await exportJWK(privateKey)), kid };
}
export const SIGNING_KEYS = [await signingKey("current"), await signingKey("previous")];

/** `Authorization: Basic` for `id` and `secret`, form-encoded first (RFC 6749 §2.3.1). */
export const basic = (id: string, secret: string) =>
  `Basic ${btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}`;

/** A token request, by default a correct one authenticated with client_secret_basic. */
export function tokenRequest(
  code: string,
  {
    form = {},
    authorization = basic(CLIENT.key, CLIENT.secret),
    contentType = "application/x-www-form-urlencoded",
  }: {
    form?: Record<string, string | undefined>;
    authorization?: string | null;
    contentType?: string;
  } = {},
): Request {
  const fields = Object.entries({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: VERIFIER,
    ...form,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return new Request(`${ISSUER}/token`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      ...(authorization ? { authorization } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The store's code row. */
type GrantRow = StoredAuthorizationCode & {
  id: string;
  consumedAt: Date | null;
  replayedAt: Date | null;
};

/**
 * Endpoints over a store holding `CLIENT`, `OTHER_CLIENT`, and the person `user-1`, an admin of
 * the Workspace `acme` where the app is installed and consented to. A test changes `person`,
 * `membership`, `consent` or `app` to model what happened since, and moves `clock.now`.
 */
export function endpoints({ signingKeys = SIGNING_KEYS }: { signingKeys?: SigningKey[] } = {}) {
  const clock = { now: NOW };
  const codes: GrantRow[] = [];
  const person = {
    username: "ada",
    displayName: "Ada Lovelace",
    email: "ada@acme.example" as string | null,
    picture: "/avatars/person-3-1.webp" as string | null,
  };
  const membership = { role: "admin" as string | undefined, installed: true };
  const consent = { revoked: false, scopes: ["openid", "profile", "email", "identity"] };
  const app = { allowedScopes: ["openid", "profile", "email", "identity"] };
  const clients = [CLIENT, OTHER_CLIENT];
  const store: GrantStore = {
    async findClient(key) {
      return clients.find((client) => client.key === key);
    },
    async findCode(codeHash) {
      const row = codes.find((code) => code.codeHash === codeHash);
      return row && { ...row };
    },
    async redeemCode(id, at) {
      const row = codes.find((code) => code.id === id);
      if (!row || row.consumedAt) return false;
      row.consumedAt = at;
      return true;
    },
    async markCodeReplayed(id, at) {
      const row = codes.find((code) => code.id === id);
      if (row) row.replayedAt ??= at;
    },
    async findRedeemedCode(id) {
      const row = codes.find((code) => code.id === id);
      return row && { ...row, replayed: row.replayedAt !== null };
    },
    async findGrantSubject({ appId, workspaceId }): Promise<GrantSubject | undefined> {
      const client = clients.find((candidate) => candidate.id === appId);
      if (!client) return undefined;
      return {
        clientId: client.key,
        appScopes: [...app.allowedScopes],
        ...(consent.revoked ? {} : { consentScopes: [...consent.scopes] }),
        installed: membership.installed,
        ...(membership.role ? { role: membership.role } : {}),
        person: { ...person },
        workspace: { id: workspaceId, slug: "acme" },
      };
    },
  };
  const options = { issuer: ISSUER, signingKeys, now: () => clock.now };
  const tokenEndpoint = new TokenEndpoint(
    store,
    options,
    // Installation tokens are exercised in oidc-installation-token.test.ts: here no installation exists.
    new InstallationTokens({ findInstallation: async () => undefined }, async () => false, options),
    NO_RATE_LIMIT,
  );
  const userInfoEndpoint = new UserInfoEndpoint(store, options);

  /** Issues a code as the authorization endpoint would, and returns it. */
  function issueCode(overrides: Partial<GrantRow> = {}): {
    code: string;
    row: GrantRow;
  } {
    const { code, codeHash } = mintAuthorizationCode();
    const row: GrantRow = {
      id: `code-${codes.length + 1}`,
      codeHash,
      appId: CLIENT.id,
      userId: "user-1",
      workspaceId: "ws-acme",
      redirectUri: REDIRECT_URI,
      codeChallenge: CHALLENGE,
      nonce: "n-1",
      scopes: ["openid", "profile", "email", "identity"],
      authTime: new Date(NOW.getTime() - 3600_000),
      expiresAt: new Date(NOW.getTime() + 600_000),
      consumedAt: null,
      replayedAt: null,
      ...overrides,
    };
    codes.push(row);
    return { code, row };
  }

  return {
    store,
    options,
    tokenEndpoint,
    userInfoEndpoint,
    issueCode,
    codes,
    person,
    membership,
    consent,
    app,
    clock,
  };
}

/** The issuer's published keys, as an app reads them from `jwks_uri`. */
export const publishedKeys = createLocalJWKSet(publicJwks(SIGNING_KEYS) as { keys: JWK[] });

/** Verifies a token as an app (or resource) would, at `NOW`. */
export async function verified(token: string, audience: string) {
  return jwtVerify(token, publishedKeys, {
    issuer: ISSUER,
    audience,
    algorithms: ["ES256"],
    currentDate: NOW,
  });
}
