import { expect, test } from "bun:test";
import { CLEANER_APP_ID } from "@lrm/coforge-sdk/internal";
import {
  handleAgentAppConfigGet,
  handleAgentAppConfigPatch,
} from "#src/routes/api/agent/v1/apps/$appId/config";
import {
  AgentAppConfigs,
  type StoredAgentAppConfig,
} from "#src/server/agent-app-configs/agent-app-configs.server";

const principal = { agentId: "agent-1" };

function appConfigs(rows: StoredAgentAppConfig[] = []) {
  return new AgentAppConfigs(
    {
      placement: async () => undefined,
      list: async (agentId) => (agentId === principal.agentId ? rows : []),
      get: async (agentId, appId) =>
        agentId === principal.agentId ? rows.find((row) => row.appId === appId) : undefined,
      async write(_agentId, appId, expectedRevision, config) {
        if ((rows.find((row) => row.appId === appId)?.revision ?? 0) !== expectedRevision)
          return false;
        rows.splice(0, rows.length, { appId, revision: expectedRevision + 1, config });
        return true;
      },
    },
    { supports: async () => false },
    async () => {},
  );
}

const patch = (body: unknown) =>
  new Request("https://server.example/api/agent/v1/apps/system.cleaner/config", {
    method: "PATCH",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("an Agent reads its own App's config", async () => {
  const response = await handleAgentAppConfigGet(principal, CLEANER_APP_ID, appConfigs());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    appId: CLEANER_APP_ID,
    revision: 0,
    overrides: {},
    effective: { enabled: true, threshold_bytes: 65_536, interval_seconds: 3600 },
  });
});

test("an App the Agent does not have is a 404", async () => {
  const response = await handleAgentAppConfigGet(principal, "system.unknown", appConfigs());
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ ok: false, errorCode: "app_not_found" });
});

test("a change at the current revision answers the new config", async () => {
  const response = await handleAgentAppConfigPatch(
    patch({
      expectedRevision: 0,
      set: { threshold_bytes: 131_072 },
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
    }),
    principal,
    CLEANER_APP_ID,
    appConfigs(),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    revision: 1,
    overrides: { threshold_bytes: 131_072 },
  });
});

test("a change against another revision is a 409 naming the current one", async () => {
  const response = await handleAgentAppConfigPatch(
    patch({ expectedRevision: 2, unset: ["enabled"] }),
    principal,
    CLEANER_APP_ID,
    appConfigs([{ appId: CLEANER_APP_ID, revision: 3, config: { enabled: false } }]),
  );
  expect(response.status).toBe(409);
  const body = (await response.json()) as { errorCode: string; error: string };
  expect(body.errorCode).toBe("revision_conflict");
  expect(body.error).toContain("3");
});

test("an invalid value or a malformed body is a 400 and stores nothing", async () => {
  const rows: StoredAgentAppConfig[] = [];
  for (const body of [
    { expectedRevision: 0, set: { threshold_bytes: 1 } },
    { expectedRevision: 0, set: {}, extra: true },
    { expectedRevision: -1 },
    { set: {} },
    { expectedRevision: 0, unset: [""] },
    "not json",
  ]) {
    const response = await handleAgentAppConfigPatch(
      patch(body),
      principal,
      CLEANER_APP_ID,
      appConfigs(rows),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, errorCode: "config_invalid" });
  }
  expect(rows).toEqual([]);
});

test("an unset key is read without surrounding spaces", async () => {
  const response = await handleAgentAppConfigPatch(
    patch({ expectedRevision: 1, unset: [" enabled "] }),
    principal,
    CLEANER_APP_ID,
    appConfigs([{ appId: CLEANER_APP_ID, revision: 1, config: { enabled: false } }]),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ revision: 2, overrides: {} });
});
