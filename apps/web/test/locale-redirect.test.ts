import { expect, test } from "bun:test";

import server from "#src/server";

// Behind Caddy the Bun server sees `http://` request URLs: TLS terminates at the proxy, and the
// browser's scheme arrives only as `X-Forwarded-Proto`. Paraglide's locale redirect is absolute, so
// it must be built from the origin the browser reached, or every unprefixed page navigation (the
// OAuth callback included) is sent to plaintext `http://`, which production does not serve.
test("a locale redirect behind the TLS proxy keeps the browser's https origin", async () => {
  const response = await server.fetch(
    new Request("http://coforge.cn/auth/callback?code=c&state=s", {
      headers: {
        "sec-fetch-dest": "document",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "coforge.cn",
      },
    }),
  );
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe(
    "https://coforge.cn/en/auth/callback?code=c&state=s",
  );
});
