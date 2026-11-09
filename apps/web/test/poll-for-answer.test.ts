import { expect, test } from "bun:test";
import { pollForAnswer } from "#src/features/computers/poll-for-answer";

type Read = { status: "pending" } | { status: "ready"; value: number } | { status: "failed" };
const gaveUp = { status: "failed" } as const;

/** A clock the test advances only by sleeping, and a read that answers from a script. */
function harness(script: Array<Read | Error>) {
  let now = 0;
  let reads = 0;
  const controller = new AbortController();
  return {
    controller,
    reads: () => reads,
    run: (deadlineMs = 10_000) =>
      pollForAnswer<Read>({
        read: async () => {
          const next = script[Math.min(reads++, script.length - 1)]!;
          if (next instanceof Error) throw next;
          return next;
        },
        onGiveUp: gaveUp,
        signal: controller.signal,
        intervalMs: 1_000,
        deadlineMs,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
  };
}

test("asks again while pending and returns the first answer", async () => {
  const { run, reads } = harness([{ status: "pending" }, { status: "ready", value: 7 }]);
  expect(await run()).toEqual({ status: "ready", value: 7 });
  expect(reads()).toBe(2);
});

test("a read that fails on the way is asked again, not taken as the answer", async () => {
  const { run } = harness([new Error("502"), { status: "ready", value: 1 }]);
  expect(await run()).toEqual({ status: "ready", value: 1 });
});

test("no answer by the deadline ends as the caller's give-up value", async () => {
  const { run, reads } = harness([{ status: "pending" }]);
  expect(await run(5_000)).toEqual(gaveUp);
  expect(reads()).toBe(6);
});

test("a first interval doubles up to the interval, so a quick answer is not kept waiting", async () => {
  const sleeps: number[] = [];
  let reads = 0;
  await pollForAnswer<Read>({
    read: async () => (reads++ < 4 ? { status: "pending" } : { status: "ready", value: 1 }),
    onGiveUp: gaveUp,
    signal: new AbortController().signal,
    firstIntervalMs: 250,
    intervalMs: 1_500,
    deadlineMs: 10_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  expect(sleeps).toEqual([250, 500, 1_000, 1_500]);
});

test("without a first interval every wait is the interval", async () => {
  const sleeps: number[] = [];
  let reads = 0;
  await pollForAnswer<Read>({
    read: async () => (reads++ < 2 ? { status: "pending" } : { status: "ready", value: 1 }),
    onGiveUp: gaveUp,
    signal: new AbortController().signal,
    intervalMs: 1_500,
    deadlineMs: 10_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  expect(sleeps).toEqual([1_500, 1_500]);
});

test("the caller going away stops the reads and ends as the give-up value", async () => {
  const { run, reads, controller } = harness([{ status: "pending" }]);
  controller.abort();
  expect(await run()).toEqual(gaveUp);
  expect(reads()).toBe(0);
});
