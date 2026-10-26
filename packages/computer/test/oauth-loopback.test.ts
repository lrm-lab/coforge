import { expect, test } from "bun:test";
import { normalizeServerUrl, OAuthDeviceClient } from "#src/oauth-device-client";

const loopbacks = ["localhost", "127.0.0.1", "[::1]"];
const unsafeOrigins = [
  "http://127.0.0.2:1234",
  "http://0.0.0.0:1234",
  "http://example.com:1234",
  "http://localhost.example.com:1234",
  "http://[::ffff:127.0.0.1]:1234",
  "http://user:password@127.0.0.1:1234",
  "http://user:password@[::1]:1234",
];

test.each(loopbacks)("OAuth accepts HTTP on the exact %s loopback", async (host) => {
  const origin = `http://${host}:1234`;
  expect(normalizeServerUrl(`${origin}/`)).toBe(origin);
  const requests: string[] = [];
  const client = new OAuthDeviceClient({
    clientId: "fixture",
    scope: "openid",
    fetch: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          issuer: origin,
          device_authorization_endpoint: `${origin}/device`,
          token_endpoint: `${origin}/token`,
        });
      }
      if (url.endsWith("/device")) {
        return Response.json({
          device_code: "fixture-code",
          user_code: "ABCD",
          verification_uri: `${origin}/activate`,
          expires_in: 60,
        });
      }
      return Response.json({ access_token: "fixture-token", token_type: "Bearer" });
    },
  });
  await expect(client.authorize(origin)).resolves.toMatchObject({
    verificationUri: `${origin}/activate`,
  });
  await expect(client.pollToken("fixture-code")).resolves.toMatchObject({ status: "authorized" });
  expect(requests).toEqual([
    `${origin}/.well-known/oauth-authorization-server`,
    `${origin}/device`,
    `${origin}/token`,
  ]);
});

test.each(unsafeOrigins)("OAuth rejects an unsafe HTTP server %s", (origin) => {
  expect(() => normalizeServerUrl(origin)).toThrow();
});

test.each(["?tenant=a", "#fragment"])("loopback server still rejects %s", (suffix) => {
  for (const host of loopbacks) {
    expect(() => normalizeServerUrl(`http://${host}:1234/${suffix}`)).toThrow();
  }
});

for (const field of ["device_authorization_endpoint", "token_endpoint", "verification_uri"]) {
  test.each(unsafeOrigins)(`OAuth rejects unsafe ${field}: %s`, async (origin) => {
    const responses = [
      Response.json({
        issuer: "https://auth.example",
        device_authorization_endpoint: "https://auth.example/device",
        token_endpoint: "https://auth.example/token",
        ...(field === "verification_uri" ? {} : { [field]: `${origin}/endpoint` }),
      }),
      Response.json({
        device_code: "fixture-code",
        user_code: "ABCD",
        verification_uri: `${origin}/activate`,
        expires_in: 60,
      }),
    ];
    const client = new OAuthDeviceClient({
      clientId: "fixture",
      scope: "openid",
      fetch: async () => responses.shift()!,
    });
    await expect(client.authorize("https://auth.example")).rejects.toThrow();
  });
}
