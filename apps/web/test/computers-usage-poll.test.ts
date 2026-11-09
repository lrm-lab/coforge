import { expect, test } from "bun:test";

import { waitForUsageScanResult } from "#src/features/computers/usage-poll";

test("usage polling waits until the new scan's own result replaces the previous one", async () => {
  const reads = [
    { state: "fresh" as const, result: { scanId: "old-scan" }, pendingScanId: "new-scan" },
    { state: "fresh" as const, result: { scanId: "old-scan" }, pendingScanId: "new-scan" },
    { state: "fresh" as const, result: { scanId: "new-scan" } },
  ];
  let count = 0;

  const result = await waitForUsageScanResult(
    "new-scan",
    async () => reads[Math.min(count++, reads.length - 1)]!,
    async () => undefined,
  );

  expect(result).toEqual({ state: "fresh", result: { scanId: "new-scan" } });
  expect(count).toBe(3);
});

test("the previous result stays readable the whole time a new scan is pending", async () => {
  const reads = [
    { state: "stale" as const, result: { scanId: "old-scan" }, pendingScanId: "new-scan" },
    { state: "fresh" as const, result: { scanId: "new-scan" } },
  ];
  let count = 0;
  const seen: unknown[] = [];

  await waitForUsageScanResult(
    "new-scan",
    async () => {
      const current = reads[Math.min(count++, reads.length - 1)]!;
      seen.push(current.result?.scanId);
      return current;
    },
    async () => undefined,
  );

  // The stale previous result was observable (never became `undefined`/missing) before the new
  // scan's own result arrived.
  expect(seen).toEqual(["old-scan", "new-scan"]);
});

test("gives up after the 60s timeout when the scan never produces its own result", async () => {
  let count = 0;
  await expect(
    waitForUsageScanResult(
      "new-scan",
      async (): Promise<{ result?: { scanId: string }; pendingScanId?: string }> => {
        count += 1;
        return { pendingScanId: "new-scan" };
      },
      async () => undefined,
    ),
  ).rejects.toThrow("usage scan timed out");
  // One initial read plus 600 retries at the 100ms poll interval covers 60s.
  expect(count).toBe(601);
});

test("a scan may still be checking authentication after the former 15s usage-only deadline", async () => {
  let count = 0;
  const result = await waitForUsageScanResult(
    "new-scan",
    async () =>
      ++count > 200 ? { result: { scanId: "new-scan" } } : { pendingScanId: "new-scan" },
    async () => undefined,
  );
  expect(result).toEqual({ result: { scanId: "new-scan" } });
});

type Reading = { result?: { scanId: string }; pendingScanId?: string };

/** Reads one after another, the last one forever, and counts them. */
function reads(...sequence: Reading[]) {
  let count = 0;
  return {
    read: async () => sequence[Math.min(count++, sequence.length - 1)]!,
    count: () => count,
  };
}

test("a scan that ended without its own result is not waited for: the read that shows it is returned", async () => {
  // The claim expired on a Computer that never answered, the reset credit result released the scan,
  // or the scan that was joined never got published: someone else's scan, or none, is pending.
  for (const ended of [
    { result: { scanId: "old-scan" } },
    { result: { scanId: "old-scan" }, pendingScanId: "other-scan" },
    { result: { scanId: "reset-request" } },
  ] satisfies Reading[]) {
    const source = reads({ result: { scanId: "old-scan" }, pendingScanId: "new-scan" }, ended);
    const result = await waitForUsageScanResult("new-scan", source.read, async () => undefined);
    expect(result).toEqual(ended);
    // The first read, then two seconds of reads at the 100ms interval that all agree.
    expect(source.count()).toBe(21);
  }
});

test("a scan's result that arrives shortly after its claim was ended is still its answer", async () => {
  // The scan that discovers a changed login has its claim ended by that report, and its own
  // result follows a moment later.
  const ended: Reading = { result: { scanId: "old-scan" } };
  const own: Reading = { result: { scanId: "new-scan" } };
  const source = reads(...Array.from({ length: 19 }, () => ended), own);
  expect(await waitForUsageScanResult("new-scan", source.read, async () => undefined)).toEqual(own);
});

test("a read that looks ended once, and then shows the scan's own result, is not an ending", async () => {
  const source = reads({ result: { scanId: "old-scan" } }, { result: { scanId: "new-scan" } });
  expect(await waitForUsageScanResult("new-scan", source.read, async () => undefined)).toEqual({
    result: { scanId: "new-scan" },
  });
});
