import { expect, test } from "bun:test";
import { RUNTIME_CATALOG_REFRESH_CLIENT_DEADLINE_MS } from "#src/features/computers/runtime-catalog-refresh-poll";
import { RedisComputerRuntimeDetection } from "#src/server/computers/computer-runtime-detection.server";
import { MODEL_CATALOG_REFRESH_DETECTING_TTL_SECONDS } from "#src/server/computers/computer-model-catalog-refresh.server";

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
    /** The one script the detection runs: delete the key only if it still holds the argument. */
    async send(command: string, args: string[]) {
      expect(command).toBe("EVAL");
      const [, , key, expected] = args as [string, string, string, string];
      if (values.get(key!)?.value !== expected) return 0;
      values.delete(key!);
      return 1;
    },
  };
}

const scope = { workspaceId: "workspace-1", computerId: "computer-1" };

test("a Computer reads as detecting its runtimes from a rescan until it ends, and never longer than the page waits for the rescan", async () => {
  const redis = fakeRedis();
  const detection = new RedisComputerRuntimeDetection(redis);
  expect(await detection.detecting(scope)).toBe(false);
  await detection.begin(scope, "request-1");
  expect(await detection.detecting(scope)).toBe(true);
  // Another Computer is not detecting.
  expect(await detection.detecting({ ...scope, computerId: "computer-2" })).toBe(false);
  // A web process that dies mid-rescan cannot leave the Computer detecting for good.
  const [entry] = redis.values.values();
  expect(Number(entry!.seconds)).toBe(MODEL_CATALOG_REFRESH_DETECTING_TTL_SECONDS);
  // And it is gone by the time the page gives up on the rescan, so a timeout notice never sits
  // beside a Computer still marked as detecting.
  expect(Number(entry!.seconds) * 1000).toBeLessThanOrEqual(
    RUNTIME_CATALOG_REFRESH_CLIENT_DEADLINE_MS,
  );
  await detection.end(scope, "request-1");
  expect(await detection.detecting(scope)).toBe(false);
});

test("a refresh that ends does not end another one still running on the Computer", async () => {
  const detection = new RedisComputerRuntimeDetection(fakeRedis());
  // The Agent form's single-provider refresh starts while the page's rescan still runs; the newest
  // request owns the mark.
  await detection.begin(scope, "rescan");
  await detection.begin(scope, "single-provider");
  await detection.end(scope, "rescan");
  expect(await detection.detecting(scope)).toBe(true);
  await detection.end(scope, "single-provider");
  expect(await detection.detecting(scope)).toBe(false);
  // An older request ending late finds nothing of its own to end.
  await detection.begin(scope, "rescan");
  await detection.begin(scope, "single-provider");
  await detection.end(scope, "single-provider");
  await detection.end(scope, "rescan");
  expect(await detection.detecting(scope)).toBe(false);
});
