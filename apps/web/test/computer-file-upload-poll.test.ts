import { expect, test } from "bun:test";
import {
  COMPUTER_FILE_UPLOAD_CLIENT_DEADLINE_MS,
  awaitComputerFileUpload,
} from "#src/features/computers/computer-file-upload-poll";
import type { ComputerFileUploadRead } from "#src/server/computers/computer-file-upload.server";

/** A clock the test advances only by sleeping, and a read that answers from a script. */
function harness(script: Array<ComputerFileUploadRead | Error>) {
  let now = 0;
  let reads = 0;
  const waits: number[] = [];
  const controller = new AbortController();
  return {
    controller,
    reads: () => reads,
    waits,
    run: (options: { deadlineMs?: number } = {}) =>
      awaitComputerFileUpload({
        read: async () => {
          const next = script[Math.min(reads++, script.length - 1)]!;
          if (next instanceof Error) throw next;
          return next;
        },
        signal: controller.signal,
        deadlineMs: options.deadlineMs,
        now: () => now,
        sleep: async (ms) => {
          waits.push(ms);
          now += ms;
        },
      }),
  };
}

const placed = {
  status: "placed",
  path: "/uploads/a.txt",
  fileName: "a.txt",
  sizeBytes: 3,
} as const;

test("polls while pending and settles on the server's outcome", async () => {
  const { run, reads, waits } = harness([{ status: "pending" }, { status: "pending" }, placed]);
  expect(await run()).toEqual(placed);
  expect(reads()).toBe(3);
  // Quick at first, then slower.
  expect(waits).toEqual([250, 500]);
});

test("a failure the server recorded is final", async () => {
  const failed = { status: "failed", reason: "offline" } as const;
  expect(await harness([{ status: "pending" }, failed]).run()).toEqual(failed);
});

test("a read that fails on the way does not end the wait", async () => {
  const { run } = harness([new Error("network"), { status: "pending" }, new Error("502"), placed]);
  expect(await run()).toEqual(placed);
});

test("no answer by the deadline ends as a timeout, and so does the page going away", async () => {
  const { run, reads } = harness([{ status: "pending" }]);
  expect(await run({ deadlineMs: 5_000 })).toEqual({ status: "failed", reason: "timeout" });
  expect(reads()).toBeGreaterThan(1);

  const gone = harness([{ status: "pending" }]);
  gone.controller.abort();
  expect(await gone.run()).toEqual({ status: "failed", reason: "timeout" });
  expect(gone.reads()).toBe(0);
});

test("the production deadline sits past the server's longest upload", () => {
  expect(COMPUTER_FILE_UPLOAD_CLIENT_DEADLINE_MS).toBe(930_000);
});
