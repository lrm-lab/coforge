import { expect, test } from "bun:test";
import { raiseRuntimeOomScore } from "#src/platform/oom-score";

test("OOM score is Linux-only and ignores a missing pid", async () => {
  let reads = 0;
  expect(
    await raiseRuntimeOomScore(undefined, {
      platform: "linux",
      read: () => {
        reads++;
        return "0";
      },
      write: () => {},
    }),
  ).toBe(false);
  expect(reads).toBe(0);
  expect(
    await raiseRuntimeOomScore(42, { platform: "darwin", read: () => "0", write: () => {} }),
  ).toBe(false);
});

test("OOM score keeps an existing protective value and raises lower values to 500", async () => {
  const writes: Array<[string, string]> = [];
  expect(
    await raiseRuntimeOomScore(42, {
      platform: "linux",
      read: () => "700\n",
      write: (...args) => writes.push(args),
    }),
  ).toBe(true);
  expect(writes).toEqual([]);
  expect(
    await raiseRuntimeOomScore(43, {
      platform: "linux",
      read: () => "-100\n",
      write: (...args) => writes.push(args),
    }),
  ).toBe(true);
  expect(writes).toEqual([["/proc/43/oom_score_adj", "500"]]);
});

test("OOM score failures are best effort and do not throw", async () => {
  expect(
    await raiseRuntimeOomScore(42, {
      platform: "linux",
      read: () => {
        throw new Error("missing proc");
      },
      write: () => {},
    }),
  ).toBe(false);
  expect(
    await raiseRuntimeOomScore(42, {
      platform: "linux",
      read: () => "0",
      write: () => {
        throw new Error("read-only proc");
      },
    }),
  ).toBe(false);
});
