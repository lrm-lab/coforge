import { expect, test } from "bun:test";

import { paraglideMiddleware } from "#src/paraglide/server";
import { isNonLocalizedRequest } from "#src/server";

/**
 * The pages served without a locale prefix (`/oidc/auth`, `/oauth/verify`) render on the server in
 * the visitor's locale, as the browser resolves it — cookie, then Accept-Language, then English —
 * so the first paint matches what hydration renders. They keep their URL: no prefix, no redirect.
 */

/** What the server renders a page request in, or where it redirects it. */
async function served(path: string, headers: Record<string, string> = {}) {
  const request = new Request(`https://coforge.example${path}`, {
    headers: { "sec-fetch-dest": "document", ...headers },
  });
  if (isNonLocalizedRequest(request)) return { locale: "en (not resolved)", url: request.url };
  const response = await paraglideMiddleware(request, ({ locale, request: resolved }) =>
    Response.json({ locale, url: resolved.url }),
  );
  if (response.status !== 200)
    return { status: response.status, location: response.headers.get("location") };
  return (await response.json()) as { locale: string; url: string };
}

const AUTHORIZE = "/oidc/auth?client_id=acme-notes&state=s";

test("an unprefixed page renders in the locale of the visitor's cookie, at its own URL", async () => {
  for (const path of [AUTHORIZE, "/oauth/verify?user_code=BCDF-GHJK"])
    expect(await served(path, { cookie: "PARAGLIDE_LOCALE=zh-CN" })).toEqual({
      locale: "zh-CN",
      url: `https://coforge.example${path}`,
    });
});

test("without a cookie it follows Accept-Language, and English otherwise", async () => {
  expect(await served(AUTHORIZE, { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" })).toMatchObject({
    locale: "zh-CN",
  });
  expect(await served(AUTHORIZE)).toMatchObject({ locale: "en" });
});

test("a localized page is still redirected to its locale prefix", async () => {
  expect(await served("/settings", { cookie: "PARAGLIDE_LOCALE=zh-CN" })).toEqual({
    status: 307,
    location: "https://coforge.example/zh-CN/settings",
  });
});
