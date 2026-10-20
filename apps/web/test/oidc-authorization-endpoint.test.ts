import { expect, test } from "bun:test";

import { hashAuthorizationCode } from "#src/server/authorization-server/authorization-codes.server";
import {
  ACME,
  APP,
  BETA,
  CHALLENGE,
  ISSUER,
  NOW,
  NOW_SECONDS,
  SIGNED_IN,
  query,
  search,
  storeWith,
} from "./oidc-authorization-fixture";

/**
 * How the authorization endpoint answers the browser's request, without a database: who is sent to
 * sign in, which Workspaces are offered, when the consent page shows, and what a code is minted
 * with. Signing in again is `oidc-authorization-sign-in.test.ts`, the answer to the page
 * `oidc-authorization-decision.test.ts`, persistence `oidc-authorization-store.integration.test.ts`.
 */

test("someone signed out is sent to sign in and back to this exact request", async () => {
  const { endpoint } = storeWith();
  const raw = `${search()}&ui_locales=zh-CN%20en`;
  expect(await endpoint.begin(raw, null)).toEqual({
    kind: "redirect",
    location: `/auth/login?returnTo=${encodeURIComponent(`/oidc/auth?${raw}`)}`,
  });
});

test("prompt=none answers login_required to someone signed out, with state and iss", async () => {
  const { endpoint } = storeWith();
  const outcome = await endpoint.begin(search({ prompt: "none" }), null);
  expect(outcome.kind).toBe("redirect");
  if (outcome.kind !== "redirect") throw new Error("unreachable");
  expect(outcome.location.startsWith("https://notes.acme.example/cb?")).toBe(true);
  expect(query(outcome.location)).toMatchObject({
    error: "login_required",
    state: "s-1",
    iss: ISSUER,
  });
});

test("an unknown app is refused on the page and a protocol error goes back to the app", async () => {
  const { endpoint } = storeWith();
  expect(await endpoint.begin(search({ client_id: "acme-other" }), SIGNED_IN)).toEqual({
    kind: "page",
    page: { view: "invalid_client", reason: "unknown_client" },
  });
  // Even signed out: the request is checked before anyone is sent to sign in.
  const outcome = await endpoint.begin(search({ code_challenge_method: "plain" }), null);
  if (outcome.kind !== "redirect") throw new Error("expected a redirect");
  expect(query(outcome.location)).toMatchObject({ error: "invalid_request", state: "s-1" });
});

test("a request too long to come back to after sign-in is invalid_request, up front", async () => {
  const { endpoint } = storeWith();
  const outcome = await endpoint.begin(search({ nonce: "n".repeat(2_000) }), null);
  if (outcome.kind !== "redirect") throw new Error("expected a redirect");
  expect(outcome.location.startsWith("https://notes.acme.example/cb?")).toBe(true);
  expect(query(outcome.location)).toMatchObject({ error: "invalid_request", state: "s-1" });
});

test("a signed-in member with no consent sees the consent page for the one Workspace", async () => {
  const { endpoint, codes } = storeWith();
  const outcome = await endpoint.begin(search({ scope: "openid email identity" }), SIGNED_IN);
  expect(outcome).toMatchObject({
    kind: "page",
    page: {
      view: "consent",
      app: { name: "Acme Notes", homepageUrl: "https://notes.acme.example/" },
      workspaces: [ACME],
      scopes: ["openid", "email", "identity"],
    },
  });
  if (outcome.kind !== "page" || outcome.page.view !== "consent") throw new Error("unreachable");
  expect(outcome.page.handle).toEqual(expect.any(String));
  expect(codes).toEqual([]);
});

test("an app that registered no homepage shows on the consent page without one", async () => {
  const { endpoint, app } = storeWith();
  app.homepageUrl = null;
  expect(await endpoint.begin(search(), SIGNED_IN)).toMatchObject({
    kind: "page",
    page: { view: "consent", app: { name: "Acme Notes", homepageUrl: null } },
  });
});

test("an app with a logo shows it on the consent page", async () => {
  const { endpoint, app } = storeWith();
  app.logoUrl = "/api/workspaces/ws-acme/apps/acme-notes/logo?v=logo-1";
  expect(await endpoint.begin(search(), SIGNED_IN)).toMatchObject({
    kind: "page",
    page: { view: "consent", app: { logoUrl: app.logoUrl } },
  });
});

test("an app installed in none of the person's Workspaces is refused on the page", async () => {
  const { endpoint, app } = storeWith({ offered: [] });
  app.logoUrl = "/api/workspaces/ws-acme/apps/acme-notes/logo?v=logo-1";
  expect(await endpoint.begin(search(), SIGNED_IN)).toEqual({
    kind: "page",
    page: {
      view: "unavailable",
      // Not its logo: the person is in no Workspace where the app is installed, and the logo's
      // route serves only people who are.
      app: { name: "Acme Notes", homepageUrl: APP.homepageUrl },
    },
  });
});

test("prompt=none never shows a page: consent, a Workspace choice or no Workspace answer an error", async () => {
  for (const [offered, error] of [
    [[ACME], "consent_required"],
    [[ACME, BETA], "interaction_required"],
    [[], "access_denied"],
  ] as const) {
    const { endpoint } = storeWith({ offered: [...offered] });
    const outcome = await endpoint.begin(search({ prompt: "none" }), SIGNED_IN);
    if (outcome.kind !== "redirect") throw new Error(`expected ${error}`);
    expect(query(outcome.location)).toMatchObject({ error, state: "s-1", iss: ISSUER });
  }
});

test("a remembered consent covering the scopes skips the page and returns a code", async () => {
  const { endpoint, codes } = storeWith({
    consents: { [ACME.id]: ["openid", "profile", "email"] },
  });
  for (const prompt of [undefined, "none"]) {
    const outcome = await endpoint.begin(search({ prompt, nonce: "n-1" }), SIGNED_IN);
    if (outcome.kind !== "redirect") throw new Error("expected a code");
    const { code, ...rest } = query(outcome.location);
    expect(rest).toEqual({ state: "s-1", iss: ISSUER });
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codes.at(-1)).toEqual({
      codeHash: hashAuthorizationCode(code!),
      appId: APP.id,
      userId: "user-1",
      workspaceId: ACME.id,
      redirectUri: "https://notes.acme.example/cb",
      codeChallenge: CHALLENGE,
      nonce: "n-1",
      scopes: ["openid", "profile"],
      authTime: new Date((NOW_SECONDS - 3600) * 1000),
      expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
    });
    expect(JSON.stringify(codes)).not.toContain(code!);
  }
  expect(new Set(codes.map((stored) => stored.codeHash)).size).toBe(2);
});

test("the consent page shows again for prompt=consent, select_account, more scopes, or a choice", async () => {
  for (const [overrides, offered] of [
    [{ prompt: "consent" }, [ACME]],
    [{ prompt: "select_account" }, [ACME]],
    [{ scope: "openid profile identity" }, [ACME]],
    [{}, [ACME, BETA]],
  ] as const) {
    const { endpoint, codes } = storeWith({
      offered: [...offered],
      consents: { [ACME.id]: ["openid", "profile"], [BETA.id]: ["openid", "profile"] },
    });
    expect(await endpoint.begin(search(overrides), SIGNED_IN)).toMatchObject({
      kind: "page",
      page: { view: "consent", workspaces: offered },
    });
    expect(codes).toEqual([]);
  }
});
