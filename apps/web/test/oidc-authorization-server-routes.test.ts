import { afterAll, beforeAll, expect, test } from "bun:test";
import { exportJWK, generateKeyPair } from "jose";

import { Route as DeviceFlowDiscoveryRoute } from "#src/routes/[.]well-known.oauth-authorization-server";
import { Route as AuthorizationServerMetadataRoute } from "#src/routes/[.]well-known.oauth-authorization-server_.oidc";
import { Route as OpenIdConfigurationRoute } from "#src/routes/oidc.[.]well-known.openid-configuration";
import { Route as JwksRoute } from "#src/routes/oidc.jwks";
import { isNonLocalizedRequest } from "#src/server";
import {
  readAuthorizationServerConfiguration,
  rememberAuthorizationServerConfiguration,
} from "#src/server/authorization-server/configuration.server";

// The device flow's discovery and the router build read process.env; the host's values, absence
// included, are restored afterwards.
const VARIABLES = ["COFORGE_E2E_ALLOW_DEVICE_AUTH", "DATABASE_URL", "REDIS_URL"] as const;
const saved = Object.fromEntries(VARIABLES.map((name) => [name, Bun.env[name]]));

beforeAll(async () => {
  for (const name of VARIABLES) delete Bun.env[name];
  // The routes serve what the boot remembered (startup-config.server.ts).
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  rememberAuthorizationServerConfiguration(
    await readAuthorizationServerConfiguration({
      COFORGE_OIDC_ISSUER: "https://coforge.example/oidc",
      COFORGE_OIDC_SIGNING_JWKS: JSON.stringify({
        keys: [{ ...(await exportJWK(privateKey)), kid: "current" }],
      }),
    }),
  );
});

afterAll(() => {
  for (const name of VARIABLES)
    if (saved[name] === undefined) delete Bun.env[name];
    else Bun.env[name] = saved[name];
});

type Handler = (context: { request: Request }) => Response | Promise<Response>;
const get = (route: { options: { server?: unknown } }, path: string) =>
  (route.options.server as { handlers: { GET: Handler } }).handlers.GET({
    request: new Request(`https://coforge.example${path}`),
  });

test("the CoForge OIDC issuer's paths bypass Paraglide localization", () => {
  expect(isNonLocalizedRequest(new Request("http://localhost/oidc/jwks"))).toBe(true);
});

test("the issuer's metadata is served at its OIDC and RFC 8414 locations alike", async () => {
  const openIdConfiguration = await get(
    OpenIdConfigurationRoute,
    "/oidc/.well-known/openid-configuration",
  );
  const metadata = await get(
    AuthorizationServerMetadataRoute,
    "/.well-known/oauth-authorization-server/oidc",
  );
  expect(openIdConfiguration.status).toBe(200);
  expect(metadata.status).toBe(200);
  const document = await openIdConfiguration.json();
  expect(document).toMatchObject({
    issuer: "https://coforge.example/oidc",
    jwks_uri: "https://coforge.example/oidc/jwks",
  });
  expect(await metadata.json()).toEqual(document);
});

test("the issuer's JWKS is served at its jwks_uri", async () => {
  const response = await get(JwksRoute, "/oidc/jwks");
  expect(response.status).toBe(200);
  expect(
    ((await response.json()) as { keys: { kid: string }[] }).keys.map((key) => key.kid),
  ).toEqual(["current"]);
});

test("the device flow's discovery is unchanged beside the issuer's", async () => {
  const response = await get(DeviceFlowDiscoveryRoute, "/.well-known/oauth-authorization-server");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    issuer: "https://coforge.example",
    device_authorization_endpoint: "https://coforge.example/oauth/device",
    token_endpoint: "https://coforge.example/oauth/token",
    coforge_workspaces_endpoint: "https://coforge.example/api/workspaces",
    grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"],
  });
});

test("the RFC 8414 issuer path is its own route, not a child of the device flow's", async () => {
  // Loading the router imports every route module; see route-tree-import.test.ts for why these
  // two are set.
  Bun.env.DATABASE_URL = "postgresql://coforge:coforge@127.0.0.1:1/unused";
  delete Bun.env.REDIS_URL;
  const { getRouter } = await import("#src/router");
  type RouteNode = { fullPath: string; parentRoute?: { id: string }; children?: unknown };
  const routes = getRouter().routesById as unknown as Record<string, RouteNode | undefined>;

  const deviceFlowDiscovery = routes["/.well-known/oauth-authorization-server"];
  expect(deviceFlowDiscovery?.fullPath).toBe("/.well-known/oauth-authorization-server");
  expect(deviceFlowDiscovery?.children).toBeUndefined();
  for (const [id, fullPath] of [
    [
      "/.well-known/oauth-authorization-server_/oidc",
      "/.well-known/oauth-authorization-server/oidc",
    ],
    ["/oidc/.well-known/openid-configuration", "/oidc/.well-known/openid-configuration"],
    ["/oidc/jwks", "/oidc/jwks"],
    ["/oidc/auth", "/oidc/auth"],
  ]) {
    expect(routes[id]?.fullPath).toBe(fullPath);
    expect(routes[id]?.parentRoute?.id).toBe("__root__");
  }
});
