import { expect, test } from "bun:test";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWK } from "jose";

import {
  AGENT_TOKEN_TTL_SECONDS,
  mintAgentAccessToken,
  verifyAccessToken,
} from "#src/server/authorization-server/issued-tokens.server";
import { publicJwks } from "#src/server/authorization-server/signing-keys.server";
import { ISSUER, NOW, NOW_SECONDS, SIGNING_KEYS } from "./oidc-token-fixture";

const issuer = { issuer: ISSUER, signingKeys: SIGNING_KEYS };
const jwks = createLocalJWKSet(publicJwks(SIGNING_KEYS) as { keys: JWK[] });
const agentToken = () =>
  mintAgentAccessToken(
    issuer,
    {
      agentId: "agent-1",
      appKey: "acme-notes",
      workspaceId: "workspace-1",
      workspaceSlug: "acme",
      scopes: ["openid", "profile", "identity"],
    },
    NOW,
  );

test("an Agent's token is a five-minute at+jwt for the app, verifiable from the issuer's JWKS", async () => {
  const token = await agentToken();
  const { payload, protectedHeader } = await jwtVerify(token, jwks, {
    issuer: ISSUER,
    audience: "acme-notes",
    typ: "at+jwt",
    algorithms: ["ES256"],
    currentDate: NOW,
  });
  expect(protectedHeader).toEqual({ alg: "ES256", kid: "current", typ: "at+jwt" });
  expect(payload).toEqual({
    iss: ISSUER,
    aud: "acme-notes",
    sub: "agent-1",
    client_id: "acme-notes",
    type: "agent",
    workspace_id: "workspace-1",
    workspace_slug: "acme",
    scope: "openid profile identity",
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 300,
    jti: expect.any(String),
  });
  expect(AGENT_TOKEN_TTL_SECONDS).toBe(300);
});

test("each Agent token has its own jti", async () => {
  const [first, second] = await Promise.all([agentToken(), agentToken()]);
  const jti = async (token: string) =>
    (await jwtVerify(token, jwks, { currentDate: NOW, audience: "acme-notes" })).payload.jti;
  expect(await jti(first)).not.toBe(await jti(second));
  expect(decodeProtectedHeader(first).kid).toBe("current");
});

test("an Agent token is not accepted where a person's access token is (UserInfo)", async () => {
  expect(await verifyAccessToken(issuer, await agentToken(), NOW)).toBeUndefined();
});

test("an Agent token has expired five minutes after it was issued", async () => {
  const later = new Date(NOW.getTime() + 301_000);
  await expect(
    jwtVerify(await agentToken(), jwks, { audience: "acme-notes", currentDate: later }),
  ).rejects.toThrow();
});
