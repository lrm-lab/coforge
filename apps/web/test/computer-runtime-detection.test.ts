import { expect, test } from "bun:test";
import { RUNTIME_CATALOG_REFRESH_CLIENT_DEADLINE_MS } from "#src/features/computers/runtime-catalog-refresh-poll";
import { RedisComputerRuntimeDetection } from "#src/server/computers/computer-runtime-detection.server";
import { MODEL_CATALOG_REFRESH_DETECTING_TTL_SECONDS } from "#src/server/computers/computer-model-catalog-refresh.server";

/** The mark holds the ids of the scans still running on a Computer, so the fake keeps a set per
 * key plus the key's TTL, and runs the two scripts the detection sends. */
function fakeRedis() {
  const values = new Map<string, { members: Set<string>; seconds: string }>();
  return {
    values,
    async send(command: string, args: string[]): Promise<unknown> {
      if (command === "SCARD") return values.get(args[0]!)?.members.size ?? 0;
      expect(command).toBe("EVAL");
      const [script, , key, member, seconds] = args as [
        string,
        string,
        string,
        string,
        string | undefined,
      ];
      if (script.includes("SADD")) {
        const entry = values.get(key!) ?? { members: new Set<string>(), seconds: seconds! };
        entry.members.add(member!);
        entry.seconds = seconds!;
        values.set(key!, entry);
        return 1;
      }
      const entry = values.get(key!);
      if (!entry) return 0;
      entry.members.delete(member!);
      if (entry.members.size === 0) values.delete(key!);
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

test("a newer scan ending first keeps the Computer detecting while an older scan still runs", async () => {
  const detection = new RedisComputerRuntimeDetection(fakeRedis());
  // The Agent form's single-provider refresh starts after the page's rescan and finishes first.
  await detection.begin(scope, "rescan");
  await detection.begin(scope, "single-provider");
  await detection.end(scope, "single-provider");
  expect(await detection.detecting(scope)).toBe(true);
  await detection.end(scope, "rescan");
  expect(await detection.detecting(scope)).toBe(false);
});
