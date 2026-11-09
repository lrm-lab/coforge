import { expect, test } from "bun:test";
import {
  RESET_CREDIT_CLIENT_DEADLINE_MS,
  awaitResetCredit,
  usageCarriesAttempt,
} from "#src/features/computers/reset-credit-poll";
import type { ResetCreditRead } from "#src/server/computers/runtime-reset-credit.server";

/** A clock the test advances only by sleeping, and a read that answers from a script. */
function harness(script: Array<ResetCreditRead | Error>) {
  let now = 0;
  let reads = 0;
  const controller = new AbortController();
  return {
    controller,
    reads: () => reads,
    run: (options: { deadlineMs?: number } = {}) =>
      awaitResetCredit({
        read: async () => {
          const next = script[Math.min(reads++, script.length - 1)]!;
          if (next instanceof Error) throw next;
          return next;
        },
        signal: controller.signal,
        intervalMs: 1_000,
        deadlineMs: options.deadlineMs ?? 10_000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
  };
}

test("polls while pending and settles on the Computer's outcome", async () => {
  const { run, reads } = harness([
    { status: "pending" },
    { status: "pending" },
    { status: "settled", outcome: "reset" },
  ]);
  expect(await run()).toEqual({ status: "settled", outcome: "reset" });
  expect(reads()).toBe(3);
});

test("a read that fails on the way does not end the wait", async () => {
  const { run } = harness([
    new Error("network"),
    { status: "pending" },
    new Error("502"),
    { status: "settled", outcome: "no_credit" },
  ]);
  expect(await run()).toEqual({ status: "settled", outcome: "no_credit" });
});

test("no answer by the deadline leaves the attempt open as unknown, so its key is kept", async () => {
  const { run, reads } = harness([{ status: "pending" }]);
  expect(await run({ deadlineMs: 5_000 })).toEqual({ status: "settled", outcome: "unknown" });
  expect(reads()).toBe(6);
  const failing = harness([new Error("down")]);
  expect(await failing.run({ deadlineMs: 5_000 })).toEqual({
    status: "settled",
    outcome: "unknown",
  });
});

test("a refusal to read ends the wait at once", async () => {
  const { run, reads } = harness([{ status: "refused", reason: "forbidden" }]);
  expect(await run()).toEqual({ status: "refused", reason: "forbidden" });
  expect(reads()).toBe(1);
});

test("unmounting stops the polling and leaves the attempt open", async () => {
  const { run, reads, controller } = harness([{ status: "pending" }]);
  controller.abort();
  expect(await run()).toEqual({ status: "settled", outcome: "unknown" });
  expect(reads()).toBe(0);
});

test("the client waits past the Computer's worst case of about 90 seconds", () => {
  expect(RESET_CREDIT_CLIENT_DEADLINE_MS).toBeGreaterThan(90_000);
});

test("the usage read carries an attempt only when its latest reading came from that request", () => {
  const read = (scanId: string) => ({ state: "fresh", result: { scanId } }) as never;
  expect(usageCarriesAttempt(read("request-1"), "request-1")).toBe(true);
  // The cache still holds an earlier scan's reading: the Computer sent none, or it was dropped.
  expect(usageCarriesAttempt(read("scan-9"), "request-1")).toBe(false);
  expect(usageCarriesAttempt({ state: "missing" }, "request-1")).toBe(false);
});
