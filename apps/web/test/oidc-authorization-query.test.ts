import { afterAll, beforeAll, expect, test } from "bun:test";

import {
  answerAuthorizationGet,
  requestedAuthorizationQuery,
} from "#src/features/app-authorization/authorization-query.server";

/**
 * The router re-serializes a page URL's query through its search parser and redirects to that
 * form, which would change a request's values (`state="x"` becomes `x`; RFC 6749 §4.1.2 needs
 * `state` back exactly). A query the router would rewrite is carried, sealed, in one parameter the
 * router leaves alone, and the page reads the request back byte for byte.
 */

const SECRET = "test-session-secret-at-least-32-characters";
const saved = Bun.env.COFORGE_SESSION_SECRET;
beforeAll(() => {
  Bun.env.COFORGE_SESSION_SECRET = SECRET;
});
afterAll(() => {
  if (saved === undefined) delete Bun.env.COFORGE_SESSION_SECRET;
  else Bun.env.COFORGE_SESSION_SECRET = saved;
});

const RENDERED = new Response("page");
const get = (query: string) =>
  answerAuthorizationGet(
    new Request(`https://coforge.example/oidc/auth?${query}`),
    async () => RENDERED,
  );

test("a query the router keeps as it is goes straight to the page", async () => {
  for (const query of [
    "client_id=acme-notes&scope=openid+profile&state=s-1",
    "client_id=acme-notes&scope=openid%20profile&state=abc_DEF-123",
  ])
    expect(await get(query)).toBe(RENDERED);
});

test("a query the router would rewrite is carried sealed, and read back byte for byte", async () => {
  for (const query of [
    "client_id=acme-notes&state=%22x%22",
    "client_id=acme-notes&state=12345678901234567890123",
    "client_id=acme-notes&nonce=1e3",
  ]) {
    const response = await get(query);
    if (!(response instanceof Response) || response === RENDERED)
      throw new Error("expected a redirect");
    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    const location = new URL(response.headers.get("location")!, "https://coforge.example");
    expect(location.pathname).toBe("/oidc/auth");
    // The sealed form is one the router keeps as it is.
    expect(await get(location.search.slice(1))).toBe(RENDERED);
    expect(await requestedAuthorizationQuery(location.search.slice(1))).toBe(query);
  }
});

test("an ordinary query is read as it is, and a forged sealed one is refused", async () => {
  expect(await requestedAuthorizationQuery("client_id=acme-notes&state=s")).toBe(
    "client_id=acme-notes&state=s",
  );
  expect(await requestedAuthorizationQuery("coforge_request=forged.value")).toBeUndefined();
});
