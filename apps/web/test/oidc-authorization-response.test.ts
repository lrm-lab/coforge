import { expect, test } from "bun:test";

import { authorizationResponseUrl } from "#src/server/authorization-server/authorization-response.server";

/** The redirect back to an app (RFC 6749 §4.1.2 and §3.1.2, RFC 9207): its parameters join the
 * registered redirect URI, whose own query is kept byte for byte. */

const ISSUER = "https://coforge.example/oidc";

test("a code goes back with the state and the issuer", () => {
  const url = authorizationResponseUrl("https://notes.acme.example/cb", ISSUER, {
    code: "abc_DEF-123",
    state: "s 1&2",
  });
  expect(url).toBe(
    "https://notes.acme.example/cb?code=abc_DEF-123&state=s+1%262&iss=https%3A%2F%2Fcoforge.example%2Foidc",
  );
  expect(Object.fromEntries(new URL(url).searchParams)).toEqual({
    code: "abc_DEF-123",
    state: "s 1&2",
    iss: ISSUER,
  });
});

test("an error goes back with its description, and without a state the request had none", () => {
  const url = new URL(
    authorizationResponseUrl("https://notes.acme.example/cb", ISSUER, {
      error: "access_denied",
      error_description: "the person denied the request",
    }),
  );
  expect(Object.fromEntries(url.searchParams)).toEqual({
    error: "access_denied",
    error_description: "the person denied the request",
    iss: ISSUER,
  });
});

test("a query already in the redirect URI is kept exactly as registered", () => {
  expect(
    authorizationResponseUrl("https://notes.acme.example/cb?tenant=a%20b&x", ISSUER, { code: "c" }),
  ).toBe(
    "https://notes.acme.example/cb?tenant=a%20b&x&code=c&iss=https%3A%2F%2Fcoforge.example%2Foidc",
  );
  expect(authorizationResponseUrl("http://localhost:9999/cb?", ISSUER, { code: "c" })).toBe(
    "http://localhost:9999/cb?code=c&iss=https%3A%2F%2Fcoforge.example%2Foidc",
  );
});
