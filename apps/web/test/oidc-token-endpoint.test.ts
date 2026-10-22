import { expect, test } from "bun:test";
import { decodeProtectedHeader } from "jose";

import {
  CLIENT,
  OTHER_CLIENT,
  basic,
  CHALLENGE,
  ISSUER,
  NOW,
  REDIRECT_URI,
  VERIFIER,
  NOW_SECONDS,
  endpoints,
  tokenRequest,
  verified,
} from "./oidc-token-fixture";

/**
 * How the token endpoint answers an app redeeming an authorization code (RFC 6749 §4.1.3–4.1.4,
 * RFC 7636 §4.6, OIDC Core §3.1.3), without a database. The UserInfo endpoint is
 * `oidc-userinfo-endpoint.test.ts`, persistence `oidc-token-store.integration.test.ts`.
 */

const USERINFO = `${ISSUER}/me`;

test("a code redeemed with client_secret_basic answers a Bearer access token and a minimal ID token", async () => {
  const { tokenEndpoint, issueCode } = endpoints();
  const { code } = issueCode();
  const response = await tokenEndpoint.exchange(tokenRequest(code));

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(
    ["access_token", "expires_in", "id_token", "scope", "token_type"].sort(),
  );
  expect(body).toMatchObject({
    token_type: "Bearer",
    expires_in: 3600,
    scope: "openid profile email identity",
  });

  const accessToken = body.access_token as string;
  expect(decodeProtectedHeader(accessToken)).toEqual({
    alg: "ES256",
    kid: "current",
    typ: "at+jwt",
  });
  const { payload: access } = await verified(accessToken, USERINFO);
  expect(access).toEqual({
    iss: ISSUER,
    sub: "user-1",
    aud: USERINFO,
    client_id: CLIENT.key,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 3600,
    jti: "code-1",
    scope: "openid profile email identity",
  });

  const idToken = body.id_token as string;
  expect(decodeProtectedHeader(idToken)).toEqual({ alg: "ES256", kid: "current", typ: "JWT" });
  const { payload: id } = await verified(idToken, CLIENT.key);
  expect(id).toEqual({
    iss: ISSUER,
    sub: "user-1",
    aud: CLIENT.key,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 3600,
    auth_time: NOW_SECONDS - 3600,
    nonce: "n-1",
    // OIDC Core §3.1.3.6: the left half of SHA-256 over the access token, base64url.
    at_hash: new Bun.CryptoHasher("sha256")
      .update(accessToken)
      .digest()
      .subarray(0, 16)
      .toString("base64url"),
  });
  // OIDC Core §5.4: with an access token issued, the scope claims are UserInfo's alone.
});

/** The error an endpoint answered, with its status and the headers every token answer carries. */
async function refusal(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  const body = (await response.json()) as { error: string };
  return {
    status: response.status,
    error: body.error,
    challenge: response.headers.get("www-authenticate"),
  };
}

test("client_secret_post authenticates the app with the secret in the form", async () => {
  const { tokenEndpoint, issueCode } = endpoints();
  const response = await tokenEndpoint.exchange(
    tokenRequest(issueCode().code, {
      authorization: null,
      form: { client_id: CLIENT.key, client_secret: CLIENT.secret },
    }),
  );
  expect(response.status).toBe(200);
});

test("an app that authenticates with no method, two methods, or a wrong secret is refused", async () => {
  const { tokenEndpoint, issueCode } = endpoints();
  const { code } = issueCode();
  const BASIC_CHALLENGE = `Basic realm="${ISSUER}"`;
  const answer = (options: Parameters<typeof tokenRequest>[1]) =>
    tokenEndpoint.exchange(tokenRequest(code, options)).then(refusal);

  // RFC 6749 §2.3: one method only.
  expect(
    await answer({ form: { client_id: CLIENT.key, client_secret: CLIENT.secret } }),
  ).toMatchObject({ status: 400, error: "invalid_request" });
  // RFC 6749 §5.2 and RFC 9110 §15.5.2: a 401 always names the scheme to use.
  for (const options of [
    { authorization: null },
    { authorization: basic(CLIENT.key, `${CLIENT.secret}x`) },
    { authorization: basic(OTHER_CLIENT.key, CLIENT.secret) },
    { authorization: "Basic not-base64!" },
    { authorization: `Bearer ${CLIENT.secret}` },
    { authorization: null, form: { client_id: CLIENT.key, client_secret: "cfa_secret_wrong" } },
    { authorization: null, form: { client_secret: CLIENT.secret } },
    // A form client_id beside Basic only names the same app.
    { form: { client_id: OTHER_CLIENT.key } },
  ])
    expect(await answer(options)).toEqual({
      status: 401,
      error: "invalid_client",
      challenge: BASIC_CHALLENGE,
    });
  // None of these spent the code.
  expect((await tokenEndpoint.exchange(tokenRequest(code))).status).toBe(200);
});

test("Basic credentials are form-decoded before they are compared (RFC 6749 §2.3.1)", async () => {
  const { tokenEndpoint, issueCode } = endpoints();
  const encoded = `Basic ${btoa(`acme%2Dnotes:${CLIENT.secret.replaceAll("_", "%5F")}`)}`;
  const response = await tokenEndpoint.exchange(
    tokenRequest(issueCode().code, { authorization: encoded }),
  );
  expect(response.status).toBe(200);
});

test("a request that is not a form, repeats a parameter, or misses one is invalid_request", async () => {
  const { tokenEndpoint, issueCode } = endpoints();
  const { code } = issueCode();
  const answer = (request: Request) => tokenEndpoint.exchange(request).then(refusal);

  // RFC 6749 §4.1.3: the form media type, which may carry a charset.
  expect(await answer(tokenRequest(code, { contentType: "application/json" }))).toMatchObject({
    status: 400,
    error: "invalid_request",
  });
  // RFC 6749 §3.2: no parameter twice.
  const twice = tokenRequest(code);
  const repeated = new Request(twice, {
    method: "POST",
    body: `${new URLSearchParams(await twice.text())}&code=${code}`,
  });
  expect(await answer(repeated)).toMatchObject({ status: 400, error: "invalid_request" });
  for (const missing of ["grant_type", "code", "redirect_uri"])
    expect(await answer(tokenRequest(code, { form: { [missing]: undefined } }))).toMatchObject({
      status: 400,
      error: "invalid_request",
    });

  const charset = await tokenEndpoint.exchange(
    tokenRequest(code, { contentType: "application/x-www-form-urlencoded; charset=UTF-8" }),
  );
  expect(charset.status).toBe(200);
});

test("only the authorization_code and client_credentials grants are supported", async () => {
  const { tokenEndpoint, issueCode } = endpoints();
  const { code } = issueCode();
  for (const grantType of ["refresh_token", "password"])
    expect(
      await tokenEndpoint
        .exchange(tokenRequest(code, { form: { grant_type: grantType } }))
        .then(refusal),
    ).toMatchObject({ status: 400, error: "unsupported_grant_type" });
});

test("a code that is unknown, expired, another app's, or presented with the wrong redirect URI or verifier is invalid_grant, and stays unspent", async () => {
  const { tokenEndpoint, issueCode, clock } = endpoints();
  const { code } = issueCode();
  const { code: othersCode } = issueCode({ appId: OTHER_CLIENT.id });
  const answer = (presented: string, form: Record<string, string | undefined> = {}) =>
    tokenEndpoint.exchange(tokenRequest(presented, { form })).then(refusal);
  const INVALID_GRANT = { status: 400, error: "invalid_grant", challenge: null };

  expect(await answer("not-a-code-we-issued")).toEqual(INVALID_GRANT);
  expect(await answer(othersCode)).toEqual(INVALID_GRANT);
  // Compared byte for byte: a trailing slash or another case is another URI.
  for (const redirectUri of [`${REDIRECT_URI}/`, REDIRECT_URI.toUpperCase(), `${REDIRECT_URI}?x=1`])
    expect(await answer(code, { redirect_uri: redirectUri })).toEqual(INVALID_GRANT);
  // RFC 7636 §4.1: 43 to 128 unreserved characters, whose S256 is the challenge.
  for (const verifier of [
    undefined,
    VERIFIER.slice(0, 42),
    `${VERIFIER}+`,
    "a".repeat(129),
    VERIFIER.replace("d", "e"),
    CHALLENGE,
  ])
    expect(await answer(code, { code_verifier: verifier })).toEqual(INVALID_GRANT);

  // Ten minutes after it was issued, the code has expired.
  const { code: expiring } = issueCode();
  clock.now = new Date(NOW.getTime() + 600_000);
  expect(await answer(expiring)).toEqual(INVALID_GRANT);

  clock.now = NOW;
  expect((await tokenEndpoint.exchange(tokenRequest(code))).status).toBe(200);
});

test("a code redeemed twice is refused, and the tokens it already yielded stop working", async () => {
  const { tokenEndpoint, userInfoEndpoint, issueCode } = endpoints();
  const { code } = issueCode();
  const first = (await (await tokenEndpoint.exchange(tokenRequest(code))).json()) as {
    access_token: string;
  };
  const userInfo = () =>
    userInfoEndpoint.answer(
      new Request(USERINFO, { headers: { authorization: `Bearer ${first.access_token}` } }),
    );
  expect((await userInfo()).status).toBe(200);

  // Another app presenting the code learns nothing and ends nothing.
  const foreign = await tokenEndpoint.exchange(
    tokenRequest(code, { authorization: basic(OTHER_CLIENT.key, "cfa_secret_x") }),
  );
  expect(foreign.status).toBe(401);
  expect((await userInfo()).status).toBe(200);

  // RFC 6749 §4.1.2 and §10.5: refused, and what it granted is withdrawn.
  expect(await tokenEndpoint.exchange(tokenRequest(code)).then(refusal)).toMatchObject({
    status: 400,
    error: "invalid_grant",
  });
  expect((await userInfo()).status).toBe(401);
});

test("two redemptions of one code at once yield one token answer", async () => {
  const { tokenEndpoint, issueCode } = endpoints();
  const { code } = issueCode();
  const answers = await Promise.all([
    tokenEndpoint.exchange(tokenRequest(code)),
    tokenEndpoint.exchange(tokenRequest(code)),
  ]);
  expect(answers.map(({ status }) => status).sort()).toEqual([200, 400]);
});

test("a person who left the Workspace before the code was redeemed gets no tokens", async () => {
  const { tokenEndpoint, issueCode, membership } = endpoints();
  const { code } = issueCode();
  membership.role = undefined;
  expect(await tokenEndpoint.exchange(tokenRequest(code)).then(refusal)).toMatchObject({
    status: 400,
    error: "invalid_grant",
  });
});

test("an ID token for a request without a nonce or extra scopes carries only the core claims", async () => {
  const { tokenEndpoint, issueCode } = endpoints();
  const { code } = issueCode({ nonce: undefined, scopes: ["openid"] });
  const body = (await (await tokenEndpoint.exchange(tokenRequest(code))).json()) as Record<
    string,
    string
  >;
  expect(body.scope).toBe("openid");
  const { payload } = await verified(body.id_token!, CLIENT.key);
  expect(Object.keys(payload).sort()).toEqual(
    ["iss", "sub", "aud", "exp", "iat", "auth_time", "at_hash"].sort(),
  );
});
