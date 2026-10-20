import { expect, test } from "bun:test";

import { hashAuthorizationCode } from "#src/server/authorization-server/authorization-codes.server";
import {
  ACME,
  APP,
  BETA,
  ISSUER,
  NOW_SECONDS,
  SIGNED_IN,
  consentHandle,
  query,
  search,
  storeWith,
} from "./oidc-authorization-fixture";

/**
 * The person's answer on the consent page. It is bound to the request the page showed, by a handle
 * the server signed: the decision never reads a request from the browser.
 */

test("approving remembers the consent with any scopes granted before, and returns a code", async () => {
  const { endpoint, codes, savedConsents } = storeWith({
    offered: [ACME, BETA],
    consents: { [BETA.id]: ["openid", "email"] },
  });
  const handle = await consentHandle(endpoint);
  const outcome = await endpoint.decide(handle, SIGNED_IN, {
    approve: true,
    workspaceId: BETA.id,
  });
  if (outcome.kind !== "redirect") throw new Error("expected a code");
  const { code, ...rest } = query(outcome.location);
  expect(rest).toEqual({ state: "s-1", iss: ISSUER });
  expect(savedConsents).toEqual([
    {
      userId: "user-1",
      appId: APP.id,
      workspaceId: BETA.id,
      scopes: ["openid", "email", "profile"],
    },
  ]);
  expect(codes).toMatchObject([
    { codeHash: hashAuthorizationCode(code!), workspaceId: BETA.id, scopes: ["openid", "profile"] },
  ]);
});

test("denying sends access_denied back with the state and iss, and remembers nothing", async () => {
  const { endpoint, codes, savedConsents } = storeWith();
  const handle = await consentHandle(endpoint);
  const outcome = await endpoint.decide(handle, SIGNED_IN, { approve: false });
  if (outcome.kind !== "redirect") throw new Error("expected a redirect");
  expect(query(outcome.location)).toMatchObject({
    error: "access_denied",
    state: "s-1",
    iss: ISSUER,
  });
  expect(codes).toEqual([]);
  expect(savedConsents).toEqual([]);
});

test("a tampered, expired or someone else's handle mints nothing and redirects nowhere", async () => {
  const { endpoint, codes, clock } = storeWith();
  const handle = await consentHandle(endpoint);
  const [body, signature] = handle.split(".");
  const tampered = `${Buffer.from(
    Buffer.from(body!, "base64url")
      .toString("utf8")
      .replace("https://notes.acme.example/cb", "https://evil.example/cb"),
  ).toString("base64url")}.${signature}`;
  const approve = { approve: true, workspaceId: ACME.id } as const;
  for (const [presented, subject] of [
    [tampered, SIGNED_IN],
    ["not-a-handle", SIGNED_IN],
    [handle, { userId: "user-2", authTime: SIGNED_IN.authTime }],
  ] as const)
    expect(await endpoint.decide(presented, subject, approve)).toEqual({
      kind: "page",
      page: { view: "expired" },
    });
  clock.now = new Date((NOW_SECONDS + 31 * 60) * 1000);
  expect(await endpoint.decide(handle, SIGNED_IN, approve)).toEqual({
    kind: "page",
    page: { view: "expired" },
  });
  expect(codes).toEqual([]);
});

test("approving for a Workspace not offered, or an app changed since, mints nothing", async () => {
  const { endpoint, codes, savedConsents, app } = storeWith();
  const handle = await consentHandle(endpoint, search({ scope: "openid email" }));
  expect(await endpoint.decide(handle, SIGNED_IN, { approve: true, workspaceId: BETA.id })).toEqual(
    {
      kind: "page",
      page: {
        view: "unavailable",
        app: { name: "Acme Notes", homepageUrl: APP.homepageUrl },
      },
    },
  );
  app.allowedScopes = ["openid", "profile"];
  const narrowed = await endpoint.decide(handle, SIGNED_IN, {
    approve: true,
    workspaceId: ACME.id,
  });
  if (narrowed.kind !== "redirect") throw new Error("expected a redirect");
  expect(query(narrowed.location)).toMatchObject({ error: "invalid_scope", state: "s-1" });
  app.redirectUris = ["https://notes.acme.example/other"];
  expect(await endpoint.decide(handle, SIGNED_IN, { approve: true, workspaceId: ACME.id })).toEqual(
    { kind: "page", page: { view: "invalid_client", reason: "invalid_redirect_uri" } },
  );
  expect(codes).toEqual([]);
  expect(savedConsents).toEqual([]);
});

test("a decision made after the session grew older than max_age answers login_required", async () => {
  const { endpoint, codes, clock } = storeWith();
  const handle = await consentHandle(endpoint, search({ max_age: "3700" }));
  clock.now = new Date((NOW_SECONDS + 200) * 1000);
  const outcome = await endpoint.decide(handle, SIGNED_IN, {
    approve: true,
    workspaceId: ACME.id,
  });
  if (outcome.kind !== "redirect") throw new Error("expected a redirect");
  expect(query(outcome.location)).toMatchObject({ error: "login_required", state: "s-1" });
  expect(codes).toEqual([]);
});
