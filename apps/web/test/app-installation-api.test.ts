import { beforeEach, expect, spyOn, test } from "bun:test";

import {
  AppInstallationApi,
  type InstallationDataGroup,
} from "#src/server/app-installation-data/app-installation-api.server";
import type { AppInstallationData } from "#src/server/app-installation-data/app-installation-data.server";
import { NO_RATE_LIMIT } from "#src/server/app-rate-limits/app-rate-limit.server";
import { ISSUER } from "./oidc-token-fixture";
import {
  INSTALLATION_ID,
  OTHER_INSTALLATION_ID,
  credentialsRequest,
  installationEndpoints,
} from "./oidc-installation-token-fixture";

/** The four read endpoints' authentication and error contract, with a real token minted by the
 * token endpoint over an in-memory installation (`workspace` and `agent` approved, `channel`
 * declared only) and a fake projection. */

const data = {
  workspace: async (id: string) => ({ id }),
  agents: async () => [{ id: "agent-1" }],
  channels: async () => [{ id: "channel-1" }],
  computers: async () => [{ id: "computer-1" }],
} as unknown as AppInstallationData;

beforeEach(() => {
  spyOn(console, "info").mockImplementation(() => {});
});

async function setup() {
  const e = installationEndpoints();
  const response = await e.tokenEndpoint.exchange(credentialsRequest());
  const { access_token: token } = (await response.json()) as { access_token: string };
  const api = new AppInstallationApi(
    e.installationTokens,
    data,
    ISSUER,
    () => e.clock.now,
    NO_RATE_LIMIT,
  );
  const read = (
    group: InstallationDataGroup,
    headers: Record<string, string> = { authorization: `Bearer ${token}` },
    id = INSTALLATION_ID,
  ) => api.read(new Request(`https://coforge.example/x`, { headers }), id, group);
  return { e, token, read };
}

test("a token with the group reads it, as JSON that is never cached", async () => {
  const { read } = await setup();
  const response = await read("agent");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({
    installation_id: INSTALLATION_ID,
    agents: [{ id: "agent-1" }],
  });
  expect(await (await read("workspace")).json()).toEqual({
    installation_id: INSTALLATION_ID,
    workspace: { id: "ws-acme" },
  });
});

test("a request without a bearer token gets the bare challenge", async () => {
  const { read } = await setup();
  for (const headers of [{} as Record<string, string>, { authorization: "Basic abc" }]) {
    const response = await read("workspace", headers);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(`Bearer realm="${ISSUER}"`);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});

test("a token that does not verify is invalid_token, whatever the reason", async () => {
  const { e, token, read } = await setup();
  const cases = [
    read("workspace", { authorization: "Bearer not-a-jwt" }),
    // Another installation's id, and an id that is not one.
    read("workspace", undefined, OTHER_INSTALLATION_ID),
    read("workspace", undefined, "not-a-uuid"),
  ];
  e.clock.now = new Date(e.clock.now.getTime() + 601_000);
  cases.push(read("workspace", { authorization: `Bearer ${token}` }));
  for (const response of await Promise.all(cases)) {
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer realm="${ISSUER}", error="invalid_token"`,
    );
    expect(await response.json()).toMatchObject({ error: "invalid_token" });
  }
});

test("a malformed Authorization header is invalid_request", async () => {
  const { read } = await setup();
  const response = await read("workspace", { authorization: "Bearer a b c" });
  expect(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("www-authenticate")).toBe(
    `Bearer realm="${ISSUER}", error="invalid_request"`,
  );
});

test("a token without the group is insufficient_scope naming the scope it lacks", async () => {
  const { read } = await setup();
  for (const group of ["channel", "computer"] as const) {
    const response = await read(group);
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer realm="${ISSUER}", error="insufficient_scope", scope="installation:${group}"`,
    );
    expect(await response.json()).toMatchObject({ error: "insufficient_scope" });
  }
});

test("a group whose approval was narrowed since is insufficient_scope", async () => {
  const { e, read } = await setup();
  e.installation.current!.approved = ["workspace"];
  const response = await read("workspace");
  expect(response.status).toBe(403);
  expect(response.headers.get("www-authenticate")).toContain('scope="installation:workspace"');
});

test("with the flag off or the installation gone the token is invalid_token", async () => {
  const { e, read } = await setup();
  e.flag.on = false;
  expect((await read("workspace")).status).toBe(401);
  e.flag.on = true;
  e.installation.current = undefined;
  expect((await read("workspace")).status).toBe(401);
});
