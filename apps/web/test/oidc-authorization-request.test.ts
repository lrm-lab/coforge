import { expect, test } from "bun:test";

import {
  parseAuthorizationRequest,
  type AuthorizationClient,
} from "#src/server/authorization-server/authorization-request.server";

/** Validating an authorization request (RFC 6749 §4.1.1 and §4.1.2.1, RFC 7636 §4.3, OIDC Core
 * §3.1.2.1-2): what is refused on the page and what goes back to the app. */

const CLIENT: AuthorizationClient = {
  key: "acme-notes",
  name: "Acme Notes",
  homepageUrl: "https://notes.acme.example/",
  redirectUris: ["https://notes.acme.example/cb", "https://notes.acme.example/cb?tenant=a"],
  allowedScopes: ["openid", "profile", "email", "identity"],
};
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const VALID = {
  client_id: "acme-notes",
  redirect_uri: "https://notes.acme.example/cb",
  response_type: "code",
  scope: "openid profile",
  state: "s-123",
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
};

const lookup = async (key: string) => (key === CLIENT.key ? CLIENT : undefined);

function parse(params: Record<string, string | undefined> | URLSearchParams) {
  const query =
    params instanceof URLSearchParams
      ? params
      : new URLSearchParams(
          Object.entries(params).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        );
  return parseAuthorizationRequest(query, lookup);
}

const withParams = (overrides: Record<string, string | undefined>) =>
  parse({ ...VALID, ...overrides });

test("a valid request is read with its scopes, PKCE challenge, nonce and prompt", async () => {
  expect(
    await withParams({
      scope: "openid  profile openid",
      nonce: "n-1",
      prompt: "login consent",
      max_age: "60",
    }),
  ).toEqual({
    status: "valid",
    client: CLIENT,
    request: {
      clientId: "acme-notes",
      redirectUri: "https://notes.acme.example/cb",
      state: "s-123",
      scopes: ["openid", "profile"],
      codeChallenge: CHALLENGE,
      nonce: "n-1",
      prompt: ["login", "consent"],
      maxAge: 60,
    },
  });
  const minimal = await withParams({ state: undefined, response_mode: "query" });
  expect(minimal).toMatchObject({ status: "valid", request: { prompt: [] } });
  if (minimal.status !== "valid") throw new Error("unreachable");
  expect(minimal.request.state).toBeUndefined();
  expect(minimal.request.nonce).toBeUndefined();
  expect(minimal.request.maxAge).toBeUndefined();
});

test("a redirect URI that carries a query matches only as the exact registered string", async () => {
  expect(
    await withParams({ redirect_uri: "https://notes.acme.example/cb?tenant=a" }),
  ).toMatchObject({ status: "valid" });
});

test("an unknown app or a redirect URI it did not register is refused on the page, never redirected", async () => {
  for (const [overrides, reason] of [
    [{ client_id: undefined }, "missing_client_id"],
    [{ client_id: "acme-other" }, "unknown_client"],
    [{ redirect_uri: undefined }, "invalid_redirect_uri"],
    [{ redirect_uri: "https://notes.acme.example/cb/" }, "invalid_redirect_uri"],
    [{ redirect_uri: "https://NOTES.acme.example/cb" }, "invalid_redirect_uri"],
    [{ redirect_uri: "https://evil.example/cb" }, "invalid_redirect_uri"],
    [{ redirect_uri: "https://notes.acme.example/cb?tenant=b" }, "invalid_redirect_uri"],
    // An unusable redirect does not excuse a bad response_type: the page still refuses it.
    [{ redirect_uri: "https://evil.example/cb", response_type: "token" }, "invalid_redirect_uri"],
  ] as const) {
    expect(await withParams(overrides)).toEqual({ status: "invalid_client", reason });
  }
});

test("a repeated client_id or redirect_uri is refused on the page", async () => {
  const twiceClient = new URLSearchParams(VALID);
  twiceClient.append("client_id", "acme-notes");
  expect(await parse(twiceClient)).toEqual({
    status: "invalid_client",
    reason: "missing_client_id",
  });
  const twiceRedirect = new URLSearchParams(VALID);
  twiceRedirect.append("redirect_uri", "https://notes.acme.example/cb");
  expect(await parse(twiceRedirect)).toEqual({
    status: "invalid_client",
    reason: "invalid_redirect_uri",
  });
});

test("with a registered redirect URI, protocol errors go back to the app with its state", async () => {
  for (const [overrides, error] of [
    [{ response_type: undefined }, "invalid_request"],
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ response_type: "code id_token" }, "unsupported_response_type"],
    [{ scope: undefined }, "invalid_scope"],
    [{ scope: "profile email" }, "invalid_scope"],
    [{ scope: "openid offline_access" }, "invalid_scope"],
    [{ code_challenge: undefined, code_challenge_method: undefined }, "invalid_request"],
    [{ code_challenge_method: undefined }, "invalid_request"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge: "too-short" }, "invalid_request"],
    [{ code_challenge: `${CHALLENGE}=` }, "invalid_request"],
    [{ request: "eyJhbGciOiJub25lIn0.e30." }, "request_not_supported"],
    [{ request_uri: "https://notes.acme.example/request.jwt" }, "request_uri_not_supported"],
    [{ prompt: "sometimes" }, "invalid_request"],
    [{ prompt: "none login" }, "invalid_request"],
    [{ response_mode: "fragment" }, "invalid_request"],
    [{ response_mode: "form_post" }, "invalid_request"],
    [{ max_age: "-1" }, "invalid_request"],
    [{ max_age: "1.5" }, "invalid_request"],
    [{ max_age: "soon" }, "invalid_request"],
  ] as const) {
    const parsed = await withParams(overrides);
    expect(parsed).toMatchObject({
      status: "error",
      redirectUri: "https://notes.acme.example/cb",
      state: "s-123",
      error,
    });
    if (parsed.status !== "error") throw new Error("unreachable");
    expect(parsed.description.length).toBeGreaterThan(0);
  }
});

test("the scopes an app may request are only those it registered", async () => {
  const narrow = { ...CLIENT, allowedScopes: ["openid", "profile"] };
  const parsed = await parseAuthorizationRequest(
    new URLSearchParams({ ...VALID, scope: "openid email" }),
    async () => narrow,
  );
  expect(parsed).toMatchObject({ status: "error", error: "invalid_scope" });
});

test("a repeated protocol parameter is invalid_request, and a repeated state is not echoed", async () => {
  const twiceScope = new URLSearchParams(VALID);
  twiceScope.append("scope", "openid");
  expect(await parse(twiceScope)).toMatchObject({
    status: "error",
    error: "invalid_request",
    state: "s-123",
  });
  const twiceState = new URLSearchParams(VALID);
  twiceState.append("state", "other");
  const parsed = await parse(twiceState);
  expect(parsed).toMatchObject({ status: "error", error: "invalid_request" });
  if (parsed.status !== "error") throw new Error("unreachable");
  expect(parsed.state).toBeUndefined();
});

test("an empty optional parameter counts as absent (RFC 6749 §3.1)", async () => {
  expect(await withParams({ state: "", nonce: "", prompt: "", max_age: "" })).toMatchObject({
    status: "valid",
    request: { prompt: [] },
  });
});
