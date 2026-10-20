import { expect, test } from "bun:test";

import { answerAuthorizationForm } from "#src/features/app-authorization/authorization-form-post";

/** `POST /oidc/auth`, which OIDC Core §3.1.2.1 requires beside GET: the form becomes the same
 * request as a GET, and the answer carries the authorization page's headers. */

const QUERY = new URLSearchParams({
  client_id: "acme-notes",
  redirect_uri: "https://notes.acme.example/cb",
  response_type: "code",
  scope: "openid",
  state: "s 1",
}).toString();

test("a form POST is answered with a 303 to the same request as a GET", async () => {
  const response = await answerAuthorizationForm(
    new Request("https://coforge.example/oidc/auth", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: QUERY,
    }),
  );
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(`/oidc/auth?${QUERY}`);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
});

test("anything but a form is refused", async () => {
  const response = await answerAuthorizationForm(
    new Request("https://coforge.example/oidc/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: "invalid_request" });
});
