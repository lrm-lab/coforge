import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevinEffortRead } from "@lrm/coforge-anvil/devin";
import { CATALOG_CACHE_TTL_MS } from "#src/code-agent/runtime-inventory-cache";
import { readDevinEffortsForCatalog } from "#src/code-agent/devin/effort-read";

const ready = (efforts: string[]): DevinEffortRead => ({ status: "ready", efforts });
const failed: DevinEffortRead = { status: "failed", code: "unavailable" };

async function directory() {
  return mkdtemp(join(tmpdir(), "daemon-devin-effort-"));
}

test("Devin efforts cache by CLI version and model; a failed model stays unread", async () => {
  const stateDirectory = await directory();
  let now = 10_000;
  let liveCalls = 0;
  const live = async (modelIds: readonly string[]) => {
    liveCalls += 1;
    return new Map(
      modelIds.map((modelId) => [modelId, modelId === "broken" ? failed : ready(["high", "max"])]),
    );
  };
  const read = (modelIds: string[], version = "3000.11.228") =>
    readDevinEffortsForCatalog({
      modelIds,
      stateDirectory,
      version,
      now: () => now,
      live,
    });
  try {
    const first = await read(["swe-2-high", "broken"]);
    expect(first.complete).toBe(false);
    expect(first.efforts.get("swe-2-high")).toEqual(["high", "max"]);
    expect(liveCalls).toBe(1);
    // The success is cached; only the failure re-reads, and it still withholds.
    const second = await read(["swe-2-high", "broken"]);
    expect(second.complete).toBe(false);
    expect(liveCalls).toBe(2);
    // A round where every model resolves publishes.
    const third = await read(["swe-2-high", "gemini-3-5-flash-medium"]);
    expect(third.complete).toBe(true);
    expect(liveCalls).toBe(3);
    // Both now cached: another round answers without a process.
    const fourth = await read(["swe-2-high", "gemini-3-5-flash-medium"]);
    expect(fourth.complete).toBe(true);
    expect(liveCalls).toBe(3);
    // A new CLI version ignores the file.
    const fifth = await read(["swe-2-high"], "3000.12.0");
    expect(fifth.complete).toBe(true);
    expect(liveCalls).toBe(4);
    // TTL expiry re-reads.
    now += CATALOG_CACHE_TTL_MS + 1;
    const sixth = await read(["swe-2-high"], "3000.12.0");
    expect(sixth.complete).toBe(true);
    expect(liveCalls).toBe(5);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
