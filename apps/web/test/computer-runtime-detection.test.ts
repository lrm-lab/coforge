import { expect, test } from "bun:test";
import { RedisComputerRuntimeDetection } from "#src/server/computers/computer-runtime-detection.server";
import {
  ComputerModelCatalogRefresh,
  MODEL_CATALOG_REFRESH_TIMEOUT_MS,
} from "#src/server/computers/computer-model-catalog-refresh.server";

function fakeRedis() {
  const values = new Map<string, { value: string; seconds: string }>();
  return {
    values,
    async set(key: string, value: string, _ex: "EX", seconds: string) {
      values.set(key, { value, seconds });
    },
    async get(key: string) {
      return values.get(key)?.value ?? null;
    },
    async del(key: string) {
      values.delete(key);
    },
  };
}

const scope = { workspaceId: "workspace-1", computerId: "computer-1" };

test("a Computer reads as detecting its runtimes from a rescan until it ends, and never longer than a rescan can take", async () => {
  const redis = fakeRedis();
  const detection = new RedisComputerRuntimeDetection(redis);
  expect(await detection.detecting(scope)).toBe(false);
  await detection.begin(scope);
  expect(await detection.detecting(scope)).toBe(true);
  // Another Computer is not detecting.
  expect(await detection.detecting({ ...scope, computerId: "computer-2" })).toBe(false);
  // A web process that dies mid-rescan cannot leave the Computer detecting for good.
  const [entry] = redis.values.values();
  expect(Number(entry!.seconds) * 1000).toBeGreaterThanOrEqual(MODEL_CATALOG_REFRESH_TIMEOUT_MS);
  await detection.end(scope);
  expect(await detection.detecting(scope)).toBe(false);
});

test("a rescan marks the Computer as detecting while it waits, and clears it whatever the outcome", async () => {
  for (const outcome of ["refreshed", "error", "timeout"] as const) {
    const marks: string[] = [];
    let now = 0;
    const refresh = new ComputerModelCatalogRefresh(
      {
        detection: {
          begin: async (value) => void marks.push(`begin:${value.computerId}`),
          end: async (value) => void marks.push(`end:${value.computerId}`),
        },
        results: {
          begin: async () => undefined,
          read: async (requestId) =>
            outcome === "timeout"
              ? undefined
              : {
                  protocolMajor: 1,
                  requestId,
                  workspaceId: scope.workspaceId,
                  computerId: scope.computerId,
                  accepted: outcome === "refreshed",
                  status: outcome,
                  message: "",
                  catalogs: [],
                },
          clear: async () => undefined,
        },
        publish: async () => void marks.push("publish"),
      },
      { now: () => now, wait: async () => void (now += 1_000), timeoutMs: 3_000 },
    );
    const result = await refresh.execute(
      { userId: "user-1", workspaceId: "workspace-1" },
      "computer-1",
    );
    expect(result.status).toBe(outcome);
    expect(marks).toEqual(["begin:computer-1", "publish", "end:computer-1"]);
  }
});
