import { expect, test } from "bun:test";

import { decodeJwt, decodeProtectedHeader, generateKeyPair, SignJWT } from "jose";

import { UserInfoEndpoint } from "#src/server/authorization-server/userinfo-endpoint.server";
import { ISSUER, NOW, SIGNING_KEYS, endpoints, tokenRequest } from "./oidc-token-fixture";

/**
 * How the UserInfo endpoint (OIDC Core §5.3, RFC 6750) answers an access token the token endpoint
 * issued: the claims its scopes release, read as they are now, and when a token stops working.
 */

const USERINFO = `${ISSUER}/me`;

/** Redeems a fresh code with `scopes` and returns the access token. */
async function accessToken(
  context: ReturnType<typeof endpoints>,
  scopes = ["openid", "profile", "email", "identity"],
): Promise<string> {
  const response = await context.tokenEndpoint.exchange(
    tokenRequest(context.issueCode({ scopes }).code),
  );
  return ((await response.json()) as { access_token: string }).access_token;
}

const bearer = (token: string, init: RequestInit = {}) =>
  new Request(USERINFO, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });

test("a Bearer access token reads the person's claims for every granted scope", async () => {
  const context = endpoints();
  const response = await context.userInfoEndpoint.answer(bearer(await accessToken(context)));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    sub: "user-1",
    name: "Ada Lovelace",
    preferred_username: "ada",
    picture: "https://coforge.example/avatars/portrait-07.webp",
    email: "ada@acme.example",
    email_verified: false,
    type: "user",
    workspace_id: "ws-acme",
    workspace_slug: "acme",
    workspace_role: "admin",
  });
});

test("each scope releases only its claims, read as they are now", async () => {
  const context = endpoints();
  const read = async (scopes: string[]) =>
    (await context.userInfoEndpoint.answer(bearer(await accessToken(context, scopes)))).json();

  expect(await read(["openid"])).toEqual({ sub: "user-1" });
  expect(await read(["openid", "identity"])).toEqual({
    sub: "user-1",
    type: "user",
    workspace_id: "ws-acme",
    workspace_slug: "acme",
    workspace_role: "admin",
  });

  const token = await accessToken(context, ["openid", "profile", "email"]);
  // Changed after the token was issued: the answer follows the person, not the token.
  context.person.displayName = "Ada King";
  context.person.picture = null;
  context.person.email = null;
  context.membership.role = "member";
  expect(await (await context.userInfoEndpoint.answer(bearer(token))).json()).toEqual({
    sub: "user-1",
    name: "Ada King",
    preferred_username: "ada",
  });
  expect(await read(["openid", "identity"])).toMatchObject({ workspace_role: "member" });
});

/** The 401's challenge (RFC 6750 §3), and the error a JSON body repeats. */
async function refusal(response: Response) {
  return {
    status: response.status,
    challenge: response.headers.get("www-authenticate"),
    body: response.headers.get("content-type")?.includes("json") ? await response.json() : null,
  };
}

const INVALID_TOKEN = {
  status: 401,
  challenge: `Bearer realm="${ISSUER}", error="invalid_token"`,
  body: { error: "invalid_token" },
};

test("no token is a bare Bearer challenge, and a token that is not ours is invalid_token", async () => {
  const context = endpoints();
  expect(await refusal(await context.userInfoEndpoint.answer(new Request(USERINFO)))).toEqual({
    status: 401,
    challenge: `Bearer realm="${ISSUER}"`,
    body: null,
  });

  const issued = await context.tokenEndpoint.exchange(tokenRequest(context.issueCode().code));
  const { access_token, id_token } = (await issued.json()) as Record<string, string>;
  const [header, payload] = access_token!.split(".");
  const foreignKey = await generateKeyPair("ES256");
  const foreign = await new SignJWT(decodeJwt(access_token!))
    .setProtectedHeader(decodeProtectedHeader(access_token!) as { alg: string })
    .sign(foreignKey.privateKey);
  for (const token of [
    "garbage",
    // An ID token is not an access token (RFC 9068 §4: typ at+jwt).
    id_token!,
    `${header}.${payload}.`,
    foreign,
  ])
    expect(await refusal(await context.userInfoEndpoint.answer(bearer(token)))).toMatchObject(
      INVALID_TOKEN,
    );

  // An hour after it was issued, the token has expired.
  context.clock.now = new Date(NOW.getTime() + 3600_000);
  expect(await refusal(await context.userInfoEndpoint.answer(bearer(access_token!)))).toMatchObject(
    INVALID_TOKEN,
  );
});

test("a token stops working when its consent is revoked, the app uninstalled, or the person leaves the Workspace", async () => {
  for (const end of [
    (context: ReturnType<typeof endpoints>) => (context.consent.revoked = true),
    (context: ReturnType<typeof endpoints>) => (context.membership.installed = false),
    (context: ReturnType<typeof endpoints>) => (context.membership.role = undefined),
  ]) {
    const context = endpoints();
    const token = await accessToken(context);
    expect((await context.userInfoEndpoint.answer(bearer(token))).status).toBe(200);
    end(context);
    expect(await refusal(await context.userInfoEndpoint.answer(bearer(token)))).toMatchObject(
      INVALID_TOKEN,
    );
  }
});

test("a POST may carry the token in the header or as a form's access_token, but not both", async () => {
  const context = endpoints();
  const token = await accessToken(context, ["openid"]);
  const form = (headers: Record<string, string> = {}) =>
    new Request(USERINFO, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ access_token: token }).toString(),
    });

  expect(await (await context.userInfoEndpoint.answer(form())).json()).toEqual({ sub: "user-1" });
  expect(
    await (await context.userInfoEndpoint.answer(bearer(token, { method: "POST" }))).json(),
  ).toEqual({ sub: "user-1" });
  expect(
    await refusal(
      await context.userInfoEndpoint.answer(form({ authorization: `Bearer ${token}` })),
    ),
  ).toMatchObject({
    status: 400,
    challenge: `Bearer realm="${ISSUER}", error="invalid_request"`,
    body: { error: "invalid_request" },
  });
  // RFC 6750 §2.3's query parameter is not accepted.
  expect(
    await refusal(
      await context.userInfoEndpoint.answer(new Request(`${USERINFO}?access_token=${token}`)),
    ),
  ).toMatchObject({ status: 401, challenge: `Bearer realm="${ISSUER}"` });
});

test("a token signed with a key since rotated to second place still verifies", async () => {
  const [current, previous] = SIGNING_KEYS;
  const before = endpoints({ signingKeys: [previous!, current!] });
  const token = await accessToken(before);
  expect(decodeProtectedHeader(token).kid).toBe("previous");
  const after = new UserInfoEndpoint(before.store, {
    ...before.options,
    signingKeys: [current!, previous!],
  });
  expect((await after.answer(bearer(token))).status).toBe(200);
  // A key no longer configured verifies nothing.
  const dropped = new UserInfoEndpoint(before.store, {
    ...before.options,
    signingKeys: [current!],
  });
  expect((await dropped.answer(bearer(token))).status).toBe(401);
});

test("narrowing the app's scopes or the person's consent narrows what an issued token releases", async () => {
  const context = endpoints();
  const token = await accessToken(context);
  context.app.allowedScopes = ["openid", "profile", "identity"];
  expect(await (await context.userInfoEndpoint.answer(bearer(token))).json()).toEqual({
    sub: "user-1",
    name: "Ada Lovelace",
    preferred_username: "ada",
    picture: "https://coforge.example/avatars/portrait-07.webp",
    type: "user",
    workspace_id: "ws-acme",
    workspace_slug: "acme",
    workspace_role: "admin",
  });
  context.consent.scopes = ["openid", "identity"];
  expect(await (await context.userInfoEndpoint.answer(bearer(token))).json()).toEqual({
    sub: "user-1",
    type: "user",
    workspace_id: "ws-acme",
    workspace_slug: "acme",
    workspace_role: "admin",
  });

  // A code redeemed after the narrowing is issued for what is left.
  const response = await context.tokenEndpoint.exchange(tokenRequest(context.issueCode().code));
  expect(((await response.json()) as { scope: string }).scope).toBe("openid identity");
});
