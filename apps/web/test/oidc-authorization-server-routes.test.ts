import { afterAll, beforeAll, expect, test } from "bun:test";
import { exportJWK, generateKeyPair } from "jose";

import { Route as DeviceFlowDiscoveryRoute } from "#src/routes/[.]well-known.oauth-authorization-server";
import { Route as AuthorizationServerMetadataRoute } from "#src/routes/[.]well-known.oauth-authorization-server_.oidc";
import { Route as OpenIdConfigurationRoute } from "#src/routes/oidc.[.]well-known.openid-configuration";
import { Route as AuthorizeRoute } from "#src/routes/oidc.auth";
import { Route as JwksRoute } from "#src/routes/oidc.jwks";
import { Route as UserInfoRoute } from "#src/routes/oidc.me";
import { Route as TokenRoute } from "#src/routes/oidc.token";
import { AUTHORIZATION_PAGE_STATUS } from "#src/features/app-authorization/app-authorization.functions";
import { isNonLocalizedPath, isRawHttpPath } from "#src/lib/non-localized-path";
import { isNonLocalizedRequest } from "#src/server";
import {
  readAuthorizationServerConfiguration,
  rememberAuthorizationServerConfiguration,
} from "#src/server/authorization-server/configuration.server";

const VARIABLES = [
  "COFORGE_E2E_ALLOW_DEVICE_AUTH",
  "COFORGE_SESSION_SECRET",
  "DATABASE_URL",
  "REDIS_URL",
] as const;
const saved = Object.fromEntries(VARIABLES.map((name) => [name, Bun.env[name]]));

beforeAll(async () => {
  for (const name of VARIABLES) delete Bun.env[name];
  Bun.env.COFORGE_SESSION_SECRET = "test-session-secret-at-least-32-characters";
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
  // `bun test` runs every file in one process, so the remembered configuration outlives this
  // file: put back "no server", what an unbooted process has (task #525). Left ready, it made
  // oidc-authorization-server.test.ts's "before the boot has remembered" case read 200.
  rememberAuthorizationServerConfiguration({ status: "disabled" });
});

type Handler = (context: { request: Request }) => Response | Promise<Response>;
const get = (route: { options: { server?: unknown } }, path: string) =>
  (route.options.server as { handlers: { GET: Handler } }).handlers.GET({
    request: new Request(`https://coforge.example${path}`),
  });

test("the CoForge OIDC issuer's paths bypass Paraglide localization", () => {
  expect(isNonLocalizedRequest(new Request("http://localhost/oidc/jwks"))).toBe(true);
  expect(isNonLocalizedRequest(new Request("http://localhost/oidc/token"))).toBe(true);
  expect(isNonLocalizedRequest(new Request("http://localhost/oidc/me"))).toBe(true);
  expect(isNonLocalizedPath("/oidc/auth")).toBe(true);
  expect(isRawHttpPath("/oidc/auth")).toBe(false);
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
    authorization_endpoint: "https://coforge.example/oidc/auth",
    token_endpoint: "https://coforge.example/oidc/token",
    userinfo_endpoint: "https://coforge.example/oidc/me",
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

test("the token and UserInfo endpoints answer at their paths, before any database read", async () => {
  // Both answers below are decided before a query; a query would fail against this address.
  Bun.env.DATABASE_URL = "postgresql://coforge:coforge@127.0.0.1:1/unused";
  type Handlers = Record<string, Handler>;
  const handlers = (route: { options: { server?: unknown } }) =>
    (route.options.server as { handlers: Handlers }).handlers;

  const token = await handlers(TokenRoute).POST!({
    request: new Request("https://coforge.example/oidc/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code&code=x",
    }),
  });
  expect(token.status).toBe(401);
  expect(token.headers.get("cache-control")).toBe("no-store");
  expect(token.headers.get("pragma")).toBe("no-cache");
  expect(token.headers.get("www-authenticate")).toBe('Basic realm="https://coforge.example/oidc"');
  expect(await token.json()).toMatchObject({ error: "invalid_client" });

  for (const method of ["GET", "POST"]) {
    const userInfo = await handlers(UserInfoRoute)[method]!({
      request: new Request("https://coforge.example/oidc/me", { method }),
    });
    expect(userInfo.status).toBe(401);
    expect(userInfo.headers.get("www-authenticate")).toBe(
      'Bearer realm="https://coforge.example/oidc"',
    );
  }
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
    ["/oidc/token", "/oidc/token"],
    ["/oidc/me", "/oidc/me"],
  ]) {
    expect(routes[id]?.fullPath).toBe(fullPath);
    expect(routes[id]?.parentRoute?.id).toBe("__root__");
  }
});

test("the authorization route declares framing and status semantics and seals form POST and rewritable GET queries", async () => {
  expect(AUTHORIZATION_PAGE_STATUS).toEqual({
    invalid_client: 400,
    expired: 400,
    unavailable: 403,
    consent: 200,
  });
  const headersFn = (AuthorizeRoute.options as { headers?: unknown }).headers as () => Record<
    string,
    string
  >;
  expect(headersFn()).toEqual({
    "content-security-policy": "frame-ancestors 'none'",
    "x-frame-options": "DENY",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });

  type AuthHandlers = {
    GET: (context: {
      request: Request;
      next: () => Promise<Response>;
    }) => Response | Promise<Response>;
    POST: (context: { request: Request }) => Response | Promise<Response>;
  };
  const authHandlers = (
    (AuthorizeRoute.options as { server?: unknown }).server as { handlers: AuthHandlers }
  ).handlers;

  const query = "client_id=acme-notes&response_type=code&scope=openid&state=s-1";
  const postResponse = await authHandlers.POST({
    request: new Request("https://coforge.example/oidc/auth", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: query,
    }),
  });
  expect(postResponse.status).toBe(303);
  expect(postResponse.headers.get("location")).toBe(`/oidc/auth?${query}`);
  expect(postResponse.headers.get("cache-control")).toBe("no-store");
  expect(postResponse.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  expect(postResponse.headers.get("x-frame-options")).toBe("DENY");

  const sealedResponse = await authHandlers.GET({
    request: new Request("https://coforge.example/oidc/auth?client_id=acme-notes&state=%22x%22"),
    next: async () => new Response("rendered"),
  });
  expect(sealedResponse.status).toBe(302);
  expect(sealedResponse.headers.get("cache-control")).toBe("no-store");
  expect(sealedResponse.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  expect(sealedResponse.headers.get("x-frame-options")).toBe("DENY");
  const sealedLocation = new URL(
    sealedResponse.headers.get("location")!,
    "https://coforge.example",
  );
  expect(sealedLocation.pathname).toBe("/oidc/auth");
  expect([...sealedLocation.searchParams.keys()]).toEqual(["coforge_request"]);
});
