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
import { RedisComputerRuntimeDetection } from "#src/server/computers/computer-runtime-detection.server";
import {
  ComputerModelCatalogRefresh,
  MODEL_CATALOG_REFRESH_PENDING_TTL_SECONDS,
} from "#src/server/computers/computer-model-catalog-refresh.server";

const redisUrl = Bun.env.MODEL_CATALOG_TEST_REDIS_URL;
if (!redisUrl || !["127.0.0.1", "localhost"].includes(new URL(redisUrl).hostname))
  throw new Error("MODEL_CATALOG_TEST_REDIS_URL must target isolated local Redis");

const viewer = { userId: "user-1", workspaceId: "workspace-1" };
const principal = { userId: "user-1", workspaceId: "workspace-1", computerId: "computer-1" };

const computerScope = { workspaceId: "workspace-1", computerId: "computer-1" };

/** The refresh over the real results store, publishing into the test instead of a Computer. */
function refreshOver(
  results: RedisModelCatalogRefreshResults,
  detection: RedisComputerRuntimeDetection,
  publish: (request: DaemonRuntimeProviderModelRefreshRequest) => Promise<void>,
) {
  return new ComputerModelCatalogRefresh({
    results,
    detection,
    publish,
    authorize: async () => true,
    online: async () => true,
    visibleProviders: async () => new Set(["antigravity"]),
  });
}

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
    const method = createDaemonRuntimeProviderModelRefreshResultMethod(results, {
      end: async () => undefined,
    });
    await method(
      encodeDaemonRuntimeProviderModelRefreshResponse({
        ...request,
        accepted: true,
        results: [
          {
            provider: "antigravity",
            status: "refreshed",
            catalog: { provider: "antigravity", models: [] },
          },
        ],
      }),
      { principal },
    );
    expect(await results.read(request.requestId)).toMatchObject({
      requestId: request.requestId,
      accepted: true,
      results: [
        {
          provider: "antigravity",
          status: "refreshed",
          catalog: { provider: "antigravity", models: [] },
        },
      ],
    });
  } finally {
    await results.clear(request.requestId);
    redis.close();
  }
});

test("a terminal probe error settles the read, and a second reply cannot change it", async () => {
  const redis = new RedisClient(redisUrl);
  const results = new RedisModelCatalogRefreshResults(redis);
  const detection = new RedisComputerRuntimeDetection(redis);
  const receive = createDaemonRuntimeProviderModelRefreshResultMethod(results, detection);
  let request: DaemonRuntimeProviderModelRefreshRequest | undefined;
  try {
    const refresh = refreshOver(results, detection, async (value) => {
      request = value;
    });
    const started = await refresh.start(viewer, { computerId: "computer-1" });
    if (started.status !== "started") throw new Error("not started");
    const ask = () =>
      refresh.read(viewer, { computerId: "computer-1", requestId: started.requestId });
    // Nothing has answered: the read asks again, and the Computer is still detecting.
    expect(await ask()).toEqual({ status: "pending" });
    expect(await detection.detecting(computerScope)).toBe(true);
    const reply = (accepted: boolean) =>
      receive(
        encodeDaemonRuntimeProviderModelRefreshResponse({
          ...request!,
          accepted,
          results: [],
        }),
        { principal },
      );
    await reply(false);
    // Storing the result ends the detecting, with no page asking.
    expect(await detection.detecting(computerScope)).toBe(false);
    await reply(true);
    expect(await detection.detecting(computerScope)).toBe(false);
    expect(await ask()).toEqual({ status: "settled", outcome: { status: "error" } });
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
    results: [],
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
    const receive = createDaemonRuntimeProviderModelRefreshResultMethod(results, {
      end: async () => undefined,
    });
    expect(
      await receive(encodeDaemonRuntimeProviderModelRefreshResponse(result), {
        principal: { userId: "user-1", workspaceId: "workspace-1", computerId: "computer-2" },
      }),
    ).toMatchObject({ code: 403 });
    expect(await results.read(request.requestId)).toBeUndefined();
    await results.accept(result);
    await results.accept({ ...result, accepted: false });
    expect(await results.read(request.requestId)).toMatchObject({ accepted: true });
  } finally {
    await results.clear(request.requestId);
    redis.close();
  }
});

test("a read stays pending past another request's report and returns only its own fresh catalog", async () => {
  const redis = new RedisClient(redisUrl);
  const results = new RedisModelCatalogRefreshResults(redis);
  const detection = new RedisComputerRuntimeDetection(redis);
  const receive = createDaemonRuntimeProviderModelRefreshResultMethod(results, detection);
  let request: DaemonRuntimeProviderModelRefreshRequest | undefined;
  const fresh: CodeAgentModelCatalog = {
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
  };
  const reply = (value: DaemonRuntimeProviderModelRefreshResponse) =>
    receive(encodeDaemonRuntimeProviderModelRefreshResponse(value), { principal });
  try {
    const refresh = refreshOver(results, detection, async (value) => {
      request = value;
    });
    const started = await refresh.start(viewer, { computerId: "computer-1" });
    if (started.status !== "started") throw new Error("not started");
    const ask = () =>
      refresh.read(viewer, { computerId: "computer-1", requestId: started.requestId });
    // Another request's report is not this request's answer.
    await reply({
      ...request!,
      requestId: crypto.randomUUID(),
      accepted: true,
      results: [
        {
          provider: "antigravity",
          status: "refreshed",
          catalog: { provider: "antigravity", models: [] },
        },
      ],
    });
    expect(await ask()).toEqual({ status: "pending" });
    expect(await detection.detecting(computerScope)).toBe(true);
    await reply({
      ...request!,
      accepted: true,
      results: [{ provider: "antigravity", status: "refreshed", catalog: fresh }],
    });
    expect(await ask()).toEqual({
      status: "settled",
      outcome: { status: "refreshed", catalogs: [fresh] },
    });
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
    expect(ttl).toBeLessThanOrEqual(MODEL_CATALOG_REFRESH_PENDING_TTL_SECONDS);
  } finally {
    await results.clear(request.requestId);
    redis.close();
  }
});

test("overlapping refreshes keep the Computer detecting until the newest one ends", async () => {
  const redis = new RedisClient(redisUrl);
  const detection = new RedisComputerRuntimeDetection(redis);
  const scope = { workspaceId: `workspace-${crypto.randomUUID()}`, computerId: "computer-1" };
  const [rescan, single] = [crypto.randomUUID(), crypto.randomUUID()];
  try {
    await detection.begin(scope, rescan);
    await detection.begin(scope, single);
    await detection.end(scope, rescan);
    expect(await detection.detecting(scope)).toBe(true);
    await detection.end(scope, single);
    expect(await detection.detecting(scope)).toBe(false);
    // A request that ends after the newest has ended, or one never begun, ends nothing new.
    await detection.begin(scope, single);
    await detection.end(scope, crypto.randomUUID());
    expect(await detection.detecting(scope)).toBe(true);
    await detection.end(scope, single);
    expect(await detection.detecting(scope)).toBe(false);
  } finally {
    await detection.end(scope, single);
    await detection.end(scope, rescan);
    redis.close();
  }
});
