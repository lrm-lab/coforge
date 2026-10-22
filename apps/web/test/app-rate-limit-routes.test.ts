import { beforeEach, expect, spyOn, test } from "bun:test";

import { AppInstallationApi } from "#src/server/app-installation-data/app-installation-api.server";
import type { AppInstallationData } from "#src/server/app-installation-data/app-installation-data.server";
import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";
import { CLIENT, ISSUER, basic, tokenRequest } from "./oidc-token-fixture";
import {
  INSTALLATION_ID,
  credentialsRequest,
  installationEndpoints,
} from "./oidc-installation-token-fixture";

/** What the rate limit does to the token endpoint and the read API, with a small in-memory limit
 * (the Redis counter is `app-rate-limit.integration.ts`). */

const LIMIT = 2;

/** Admits `LIMIT` requests per id, then refuses with a seven-second wait; records the ids asked. */
function smallLimit() {
  const counts = new Map<string, number>();
  const limit: AppRateLimit & { counts: typeof counts } = {
    counts,
    async admit(id) {
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      return count <= LIMIT ? { allowed: true } : { allowed: false, retryAfterSeconds: 7 };
    },
  };
  return limit;
}

beforeEach(() => {
  spyOn(console, "info").mockImplementation(() => {});
});

async function expectRateLimited(response: Response) {
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("7");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ error: "rate_limited" });
}

test("client_credentials is refused with 429 past the limit, counted per client", async () => {
  const limit = smallLimit();
  const e = installationEndpoints({ limit });
  for (let i = 0; i < LIMIT; i++)
    expect((await e.tokenEndpoint.exchange(credentialsRequest())).status).toBe(200);
  await expectRateLimited(await e.tokenEndpoint.exchange(credentialsRequest()));
  expect([...limit.counts.keys()]).toEqual([CLIENT.id]);
});

test("a request that does not authenticate the client does not spend its budget", async () => {
  const limit = smallLimit();
  const e = installationEndpoints({ limit });
  for (let i = 0; i < 2 * LIMIT; i++) {
    const response = await e.tokenEndpoint.exchange(
      credentialsRequest({ authorization: basic(CLIENT.key, "wrong") }),
    );
    expect(response.status).toBe(401);
  }
  expect(limit.counts.size).toBe(0);
  expect((await e.tokenEndpoint.exchange(credentialsRequest())).status).toBe(200);
});

test("the authorization_code grant is not limited", async () => {
  const limit = smallLimit();
  const e = installationEndpoints({ limit });
  for (let i = 0; i < 2 * LIMIT; i++) {
    const response = await e.tokenEndpoint.exchange(tokenRequest("unknown"));
    expect(response.status).toBe(400);
  }
  expect(limit.counts.size).toBe(0);
});

const data = { workspace: async (id: string) => ({ id }) } as unknown as AppInstallationData;

async function readApi(limit: AppRateLimit) {
  const e = installationEndpoints();
  const response = await e.tokenEndpoint.exchange(credentialsRequest());
  const { access_token: token } = (await response.json()) as { access_token: string };
  const api = new AppInstallationApi(e.installationTokens, data, ISSUER, () => e.clock.now, limit);
  const read = (authorization = `Bearer ${token}`) =>
    api.read(
      new Request("https://coforge.example/x", { headers: { authorization } }),
      INSTALLATION_ID,
      "workspace",
    );
  return { read };
}

test("a read is refused with 429 past the limit, counted per installation", async () => {
  const limit = smallLimit();
  const { read } = await readApi(limit);
  for (let i = 0; i < LIMIT; i++) expect((await read()).status).toBe(200);
  await expectRateLimited(await read());
  expect([...limit.counts.keys()]).toEqual([INSTALLATION_ID]);
});

test("a request whose token does not verify does not spend the installation's budget", async () => {
  const limit = smallLimit();
  const { read } = await readApi(limit);
  for (let i = 0; i < 2 * LIMIT; i++) expect((await read("Bearer not-a-jwt")).status).toBe(401);
  expect(limit.counts.size).toBe(0);
  expect((await read()).status).toBe(200);
});
