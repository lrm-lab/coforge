import { expect, test } from "bun:test";

import { NOW_SECONDS, SIGNED_IN, query, search, storeWith } from "./oidc-authorization-fixture";

/**
 * `prompt=login` and `max_age` (OIDC Core §3.1.2.1): the person is sent to sign in again once,
 * comes back to the same request, and is let through only when they did sign in again; otherwise
 * the app gets `login_required`, never a loop.
 */

/** Where sign-in sends the person back to, from a `/auth/login?prompt=login` location. */
function signInAgain(location: string): string {
  const url = new URL(location, "https://coforge.example");
  expect(url.pathname).toBe("/auth/login");
  expect(url.searchParams.get("prompt")).toBe("login");
  const returnTo = url.searchParams.get("returnTo")!;
  expect(returnTo.startsWith("/oidc/auth?")).toBe(true);
  return returnTo.slice("/oidc/auth?".length);
}

const returnedFresh = { userId: "user-1", authTime: NOW_SECONDS + 5 };

test("prompt=login sends a signed-in person to sign in again, back to the same request", async () => {
  const { endpoint, clock } = storeWith({ consents: { "ws-acme": ["openid", "profile"] } });
  const original = search({ prompt: "login" });
  const first = await endpoint.begin(original, SIGNED_IN);
  if (first.kind !== "redirect") throw new Error("expected a redirect");
  const back = signInAgain(first.location);
  // The request itself comes back unchanged, prompt=login included.
  const params = new URLSearchParams(back);
  for (const [name, value] of new URLSearchParams(original)) expect(params.get(name)).toBe(value);

  clock.now = new Date((NOW_SECONDS + 10) * 1000);
  const returned = await endpoint.begin(back, returnedFresh);
  if (returned.kind !== "redirect") throw new Error("expected a code");
  expect(query(returned.location).code).toBeDefined();
});

test("coming back without a new sign-in answers login_required instead of asking again", async () => {
  const { endpoint } = storeWith({ consents: { "ws-acme": ["openid", "profile"] } });
  for (const overrides of [{ prompt: "login" }, { max_age: "600" }]) {
    const first = await endpoint.begin(search(overrides), SIGNED_IN);
    if (first.kind !== "redirect") throw new Error("expected a redirect");
    const returned = await endpoint.begin(signInAgain(first.location), SIGNED_IN);
    if (returned.kind !== "redirect") throw new Error("expected a redirect");
    expect(query(returned.location)).toMatchObject({ error: "login_required", state: "s-1" });
  }
});

test("max_age=0 is met by the sign-in it asked for", async () => {
  const { endpoint, clock } = storeWith({ consents: { "ws-acme": ["openid", "profile"] } });
  const first = await endpoint.begin(search({ max_age: "0" }), SIGNED_IN);
  if (first.kind !== "redirect") throw new Error("expected a redirect");
  clock.now = new Date((NOW_SECONDS + 30) * 1000);
  const returned = await endpoint.begin(signInAgain(first.location), returnedFresh);
  if (returned.kind !== "redirect") throw new Error("expected a code");
  expect(query(returned.location).code).toBeDefined();
});

test("max_age lets a recent enough session through, and prompt=none never sends anyone to sign in", async () => {
  const { endpoint } = storeWith({ consents: { "ws-acme": ["openid", "profile"] } });
  const fresh = await endpoint.begin(search({ max_age: "7200" }), SIGNED_IN);
  if (fresh.kind !== "redirect") throw new Error("expected a code");
  expect(query(fresh.location).code).toBeDefined();
  const silent = await endpoint.begin(search({ max_age: "600", prompt: "none" }), SIGNED_IN);
  if (silent.kind !== "redirect") throw new Error("expected a redirect");
  expect(query(silent.location)).toMatchObject({ error: "login_required", state: "s-1" });
});

test("signed out, prompt=login and max_age ask Authing to sign in afresh, once", async () => {
  const { endpoint, clock } = storeWith({ consents: { "ws-acme": ["openid", "profile"] } });
  for (const overrides of [{ prompt: "login" }, { max_age: "60" }]) {
    const first = await endpoint.begin(search(overrides), null);
    if (first.kind !== "redirect") throw new Error("expected a redirect");
    const back = signInAgain(first.location);
    clock.now = new Date((NOW_SECONDS + 10) * 1000);
    const returned = await endpoint.begin(back, returnedFresh);
    if (returned.kind !== "redirect") throw new Error("expected a code");
    expect(query(returned.location).code).toBeDefined();
  }
});

test("a sign-in marker the app or anyone else wrote is ignored", async () => {
  const { endpoint } = storeWith({ consents: { "ws-acme": ["openid", "profile"] } });
  const forged = await endpoint.begin(
    `${search({ prompt: "login" })}&coforge_signed_in_after=forged.value`,
    SIGNED_IN,
  );
  if (forged.kind !== "redirect") throw new Error("expected a redirect");
  signInAgain(forged.location);
});
