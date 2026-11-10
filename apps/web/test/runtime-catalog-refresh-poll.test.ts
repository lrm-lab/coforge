import { expect, test } from "bun:test";
import type {
  ModelCatalogRefreshRead,
  ModelCatalogRefreshStart,
} from "#src/server/computers/computer-model-catalog-refresh.server";
import {
  awaitRuntimeCatalogRefresh,
  RUNTIME_CATALOG_REFRESH_CLIENT_DEADLINE_MS,
} from "#src/features/computers/runtime-catalog-refresh-poll";

const catalog = { provider: "codex" as const, models: [] };

/** A clock the test advances only by sleeping, and reads answered from a script. */
function harness(options: { start?: ModelCatalogRefreshStart; reads?: ModelCatalogRefreshRead[] }) {
  let now = 0;
  const asked: string[] = [];
  const reads = options.reads ?? [{ status: "pending" }];
  const controller = new AbortController();
  return {
    controller,
    asked,
    elapsed: () => now,
    run: () =>
      awaitRuntimeCatalogRefresh({
        start: async () => options.start ?? { status: "started", requestId: "request-1" },
        read: async (requestId) => {
          asked.push(requestId);
          return reads[Math.min(asked.length - 1, reads.length - 1)]!;
        },
        signal: controller.signal,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
  };
}

test("a refresh that could not start is an error and reads nothing", async () => {
  const { run, asked } = harness({ start: { status: "failed" } });
  expect(await run()).toEqual({ status: "error" });
  expect(asked).toEqual([]);
});

test("a refresh the viewer may not start is a thrown failure and reads nothing", async () => {
  const { run, asked } = harness({ start: { status: "refused" } });
  await expect(run()).rejects.toThrow("Computer is not available");
  expect(asked).toEqual([]);
});

test("asks for the started request until it settles, then returns the outcome", async () => {
  const outcome = { status: "refreshed" as const, catalog };
  const { run, asked } = harness({
    reads: [{ status: "pending" }, { status: "pending" }, { status: "settled", outcome }],
  });
  expect(await run()).toEqual(outcome);
  expect(asked).toEqual(["request-1", "request-1", "request-1"]);
});

test("a per-runtime failure reaches the caller with its reason", async () => {
  const outcome = {
    status: "error" as const,
    provider: "codex" as const,
    code: "probe_failed" as const,
    diagnostic: "boom",
  };
  const { run } = harness({ reads: [{ status: "settled", outcome }] });
  expect(await run()).toEqual(outcome);
});

test("a refusal to read is a failure the caller sees as a thrown one", async () => {
  const { run } = harness({ reads: [{ status: "refused" }] });
  await expect(run()).rejects.toThrow("Computer is not available");
});

test("no answer by the deadline is a timeout", async () => {
  const { run, elapsed } = harness({ reads: [{ status: "pending" }] });
  expect(await run()).toEqual({ status: "timeout" });
  expect(elapsed()).toBeGreaterThanOrEqual(RUNTIME_CATALOG_REFRESH_CLIENT_DEADLINE_MS);
});

test("the caller going away ends the wait as a timeout", async () => {
  const { run, controller } = harness({ reads: [{ status: "pending" }] });
  controller.abort();
  expect(await run()).toEqual({ status: "timeout" });
});
