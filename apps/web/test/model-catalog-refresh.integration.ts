import { expect, test } from "bun:test";
import { RedisClient } from "bun";
import {
  decodeDaemonRuntimeProviderModelRefreshResponse,
  encodeDaemonRuntimeProviderModelRefreshResponse,
  type DaemonRuntimeProviderModelRefreshRequest,
  type DaemonRuntimeProviderModelRefreshResponse,
  type CodeAgentModelCatalog,
} from "@lrm/coforge-sdk/internal";
import { createDaemonRuntimeProviderModelRefreshResultMethod } from "#src/server/centrifugo/rpc-handler.server";
import { RedisPendingResults } from "#src/server/centrifugo/redis-pending-results.server";
import { RedisModelCatalogRefreshResults } from "#src/server/centrifugo/model-catalog-refresh-cache.server";
import {
  ComputerModelCatalogRefresh,
  MODEL_CATALOG_REFRESH_TIMEOUT_MS,
} from "#src/server/computers/computer-model-catalog-refresh.server";

const redisUrl = Bun.env.MODEL_CATALOG_TEST_REDIS_URL;
if (!redisUrl || !["127.0.0.1", "localhost"].includes(new URL(redisUrl).hostname))
  throw new Error("MODEL_CATALOG_TEST_REDIS_URL must target isolated local Redis");

test("a model refresh makes its own terminal catalog observable to the waiting request", async () => {
  const redis = new RedisClient(redisUrl);
  const request: DaemonRuntimeProviderModelRefreshRequest = {
    protocolMajor: 1,
    requestId: crypto.randomUUID(),
    workspaceId: "workspace-1",
    computerId: "computer-1",
  };
  const results = new RedisPendingResults<
    DaemonRuntimeProviderModelRefreshRequest,
    DaemonRuntimeProviderModelRefreshResponse
  >(redis, {
    prefix: `coforge:test:model-refresh:${request.requestId}`,
    encode: encodeDaemonRuntimeProviderModelRefreshResponse,
    decode: decodeDaemonRuntimeProviderModelRefreshResponse,
    sameScope: (pending, result) =>
      pending.requestId === result.requestId &&
      pending.workspaceId === result.workspaceId &&
      pending.computerId === result.computerId,
  });
  try {
    await results.begin({ request, userId: "user-1", revision: "" });
    const method = createDaemonRuntimeProviderModelRefreshResultMethod(results);
    await method(
      encodeDaemonRuntimeProviderModelRefreshResponse({
        ...request,
        accepted: true,
        status: "refreshed",
        catalogs: [{ provider: "antigravity", models: [] }],
      }),
      {
        principal: {
          userId: "user-1",
          workspaceId: request.workspaceId,
          computerId: request.computerId,
        },
      },
    );
    expect(await results.read(request.requestId)).toMatchObject({
      requestId: request.requestId,
      accepted: true,
      status: "refreshed",
      catalogs: [{ provider: "antigravity", models: [] }],
    });
  } finally {
    await results.clear(request.requestId);
    redis.close();
  }
});

test("a terminal probe error and a missing reply stay failures and clear pending state", async () => {
  const redis = new RedisClient(redisUrl);
  const results = new RedisModelCatalogRefreshResults(redis);
  const receive = createDaemonRuntimeProviderModelRefreshResultMethod(results);
  let request: DaemonRuntimeProviderModelRefreshRequest | undefined;
  try {
    for (const outcome of ["error", "timeout"] as const) {
      let now = 0;
      const refresh = new ComputerModelCatalogRefresh(
        {
          results,
          detection: { begin: async () => {}, end: async () => {} },
          async publish(value) {
            request = value;
            if (outcome === "error")
              await receive(
                encodeDaemonRuntimeProviderModelRefreshResponse({
                  ...value,
                  accepted: false,
                  status: "error",
                  message: "fixture probe failed",
                }),
                {
                  principal: {
                    userId: "user-1",
                    workspaceId: value.workspaceId,
                    computerId: value.computerId,
                  },
                },
              );
          },
        },
        {
          now: () => now,
          timeoutMs: 1,
          wait: async () => {
            now = 1;
          },
        },
      );
      expect(
        await refresh.execute({ userId: "user-1", workspaceId: "workspace-1" }, "computer-1"),
      ).toEqual({ status: outcome });
      expect(await results.read(request!.requestId)).toBeUndefined();
      await results.accept({ ...request!, accepted: true, status: "refreshed", catalogs: [] });
      expect(await results.read(request!.requestId)).toBeUndefined();
    }
  } finally {
    if (request) await results.clear(request.requestId);
    redis.close();
  }
});

test("foreign scope and unauthorized replies cannot complete a model refresh", async () => {
  const redis = new RedisClient(redisUrl);
  const results = new RedisModelCatalogRefreshResults(redis);
  const request: DaemonRuntimeProviderModelRefreshRequest = {
    protocolMajor: 1,
    requestId: crypto.randomUUID(),
    workspaceId: "workspace-1",
    computerId: "computer-1",
  };
  const result: DaemonRuntimeProviderModelRefreshResponse = {
    ...request,
    accepted: true,
    status: "refreshed",
    catalogs: [],
  };
  try {
    await results.begin({ request, userId: "user-1", revision: "" });
    for (const foreign of [
      { ...result, protocolMajor: 2 },
      { ...result, workspaceId: "workspace-2" },
      { ...result, computerId: "computer-2" },
      { ...result, requestId: crypto.randomUUID() },
    ]) {
      await results.accept(foreign);
      expect(await results.read(request.requestId)).toBeUndefined();
    }
    const receive = createDaemonRuntimeProviderModelRefreshResultMethod(results);
    expect(
      await receive(encodeDaemonRuntimeProviderModelRefreshResponse(result), {
        principal: { userId: "user-1", workspaceId: "workspace-1", computerId: "computer-2" },
      }),
    ).toMatchObject({ code: 403 });
    expect(await results.read(request.requestId)).toBeUndefined();
    await results.accept(result);
    await results.accept({ ...result, accepted: false, status: "error" });
    expect(await results.read(request.requestId)).toMatchObject({
      accepted: true,
      status: "refreshed",
    });
  } finally {
    await results.clear(request.requestId);
    redis.close();
  }
});

test("a refresh waits past another request's report and returns only its own fresh catalog", async () => {
  const redis = new RedisClient(redisUrl);
  const results = new RedisModelCatalogRefreshResults(redis);
  const receive = createDaemonRuntimeProviderModelRefreshResultMethod(results);
  let request: DaemonRuntimeProviderModelRefreshRequest | undefined;
  const fresh: CodeAgentModelCatalog[] = [
    {
      provider: "antigravity",
      models: [
        {
          id: "gemini-4-fixture",
          modelProvider: "",
          displayName: "New fixture model",
          reasoningEfforts: [],
          defaultReasoning: "",
          description: "",
          recommended: false,
        },
      ],
    },
  ];
  const reply = (value: DaemonRuntimeProviderModelRefreshResponse) =>
    receive(encodeDaemonRuntimeProviderModelRefreshResponse(value), {
      principal: { userId: "user-1", workspaceId: "workspace-1", computerId: "computer-1" },
    });
  let waits = 0;
  let now = 0;
  try {
    const refresh = new ComputerModelCatalogRefresh(
      {
        results,
        detection: { begin: async () => {}, end: async () => {} },
        async publish(value) {
          request = value;
          await reply({
            ...value,
            requestId: crypto.randomUUID(),
            accepted: true,
            status: "refreshed",
            catalogs: [{ provider: "antigravity", models: [] }],
          });
          expect(await results.read(value.requestId)).toBeUndefined();
        },
      },
      {
        now: () => now,
        timeoutMs: MODEL_CATALOG_REFRESH_TIMEOUT_MS,
        async wait() {
          waits += 1;
          now = 21_000;
          await reply({ ...request!, accepted: true, status: "refreshed", catalogs: fresh });
        },
      },
    );
    expect(
      await refresh.execute({ userId: "user-1", workspaceId: "workspace-1" }, "computer-1"),
    ).toEqual({ status: "refreshed", catalogs: fresh });
    expect(waits).toBe(1);
    expect(await results.read(request!.requestId)).toBeUndefined();
  } finally {
    if (request) await results.clear(request.requestId);
    redis.close();
  }
});

test("pending model refreshes outlive the normal slow-probe budget", async () => {
  const redis = new RedisClient(redisUrl);
  const results = new RedisModelCatalogRefreshResults(redis);
  const request = {
    protocolMajor: 1,
    requestId: crypto.randomUUID(),
    workspaceId: "workspace-1",
    computerId: "computer-1",
  };
  try {
    await results.begin({ request, userId: "user-1", revision: "" });
    const ttl = Number(
      await redis.send("TTL", [`coforge:model-catalog-refresh:v1:${request.requestId}:pending`]),
    );
    expect(ttl).toBeGreaterThan(45);
  } finally {
    await results.clear(request.requestId);
    redis.close();
  }
});
