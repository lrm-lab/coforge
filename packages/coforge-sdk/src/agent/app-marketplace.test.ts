import { expect, test } from "bun:test";
import { decodeAgentAppMarketplaceResponse } from "./app-marketplace";
import { agentApiRoutes } from "./routes";

const app = {
  key: "acme",
  name: "Acme",
  description: "Reads things",
  category: "data-analytics",
  developer: "Acme Labs",
  homepageUrl: null,
  homepageHost: null,
  callbackDomains: ["acme.example"],
  allowedScopes: ["openid"],
  permissionGroups: [],
  notificationEvents: [],
  logoUrl: null,
  installCount: 1,
  publishedAt: null,
  installed: false,
};
const body = {
  surface: "public_marketplace",
  metadataTrust: "untrusted_app_supplied",
  query: null,
  limit: 20,
  truncated: false,
  apps: [app],
};

test("the marketplace route is the same in every mode", () => {
  for (const mode of ["proxy", "local", "cloud"] as const)
    expect(agentApiRoutes[mode].apps.marketplace).toEqual({
      method: "GET",
      path: "/api/agent/v1/apps/marketplace",
    });
});

test("a response decodes to its known fields only, and a malformed one is refused", () => {
  expect(
    decodeAgentAppMarketplaceResponse({ ...body, apps: [{ ...app, appId: "internal" }] }),
  ).toEqual(body as never);
  for (const bad of [
    { ...body, surface: "other" },
    { ...body, apps: [{ ...app, installed: "no" }] },
    { ...body, truncated: undefined },
    null,
  ])
    expect(() => decodeAgentAppMarketplaceResponse(bad)).toThrow(
      "invalid Agent app marketplace response",
    );
});
