import { expect, test } from "bun:test";
import {
  COMPACTION_BEFORE_STALE_MS,
  PhaseBookkeeping,
} from "#src/daemon-runtime/phase-bookkeeping";
import type { ActivityLaunch } from "#src/daemon-runtime/activity-launch";
import type { ActivityDraft } from "#src/daemon-runtime/agent-activity-publisher";
import { captureDaemonLogs } from "./log-capture";

const launch = { launchId: "launch-a", clientSeq: 0, stopping: false } as ActivityLaunch;
type Reading = { usedTokens: number; windowTokens: number; observedAtMs: number };

function subject(readings: Reading[]) {
  const bookkeeping = new PhaseBookkeeping({
    launchFor: () => launch,
    publish: () => {},
    activityDraft: () => ({}) as ActivityDraft,
    contexts: {
      newContext: () => {},
      compactionFailed: () => ({ consecutive: 1, terminal: false }),
      compactionSucceeded: () => {},
    },
    contextUsage: () => readings.at(-1),
  });
  return { bookkeeping, readings };
}

function line(records: Array<{ properties: Record<string, unknown> }>) {
  return records
    .map((record) => record.properties)
    .find((properties) => properties.event === "agent.runtime.compaction_tokens");
}

async function compactionAfterReadingAged(ageMs: number, reported?: { tokensBefore: number }) {
  const { bookkeeping } = subject([
    { usedTokens: 151_418, windowTokens: 512_000, observedAtMs: Date.now() - ageMs },
  ]);
  const { records } = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", launch, undefined);
    bookkeeping.finish("compaction", "agent-a", launch, undefined, reported);
    bookkeeping.turnEnded("agent-a");
  });
  return line(records);
}

test("a before reading older than the stale age says so, with its age", async () => {
  const written = await compactionAfterReadingAged(COMPACTION_BEFORE_STALE_MS + 60_000);
  expect(written?.tokens_before).toBe(151_418);
  expect(written?.tokens_before_stale).toBe(true);
  expect(written?.tokens_before_age_ms).toBeGreaterThanOrEqual(COMPACTION_BEFORE_STALE_MS + 60_000);
});

test("a recent before reading is reported with its age and no stale mark", async () => {
  const written = await compactionAfterReadingAged(30_000);
  expect(written?.tokens_before).toBe(151_418);
  expect(written?.tokens_before_stale).toBeUndefined();
  expect(written?.tokens_before_age_ms).toBeGreaterThanOrEqual(30_000);
  expect(written?.tokens_before_age_ms).toBeLessThan(COMPACTION_BEFORE_STALE_MS);
});

test("a before number the runtime reported itself has no age and is never stale", async () => {
  const written = await compactionAfterReadingAged(COMPACTION_BEFORE_STALE_MS * 10, {
    tokensBefore: 112_630,
  });
  expect(written?.tokens_before).toBe(112_630);
  expect(written?.tokens_before_age_ms).toBeUndefined();
  expect(written?.tokens_before_stale).toBeUndefined();
});

test("the age is measured when the compaction opened, not when its line is finally written", async () => {
  const { bookkeeping, readings } = subject([
    { usedTokens: 151_418, windowTokens: 512_000, observedAtMs: Date.now() - 30_000 },
  ]);
  const originalNow = Date.now;
  const opened = originalNow();
  const { records } = await captureDaemonLogs(async () => {
    Date.now = () => opened;
    bookkeeping.start("compaction", "agent-a", launch, undefined);
    bookkeeping.finish("compaction", "agent-a", launch, undefined);
    Date.now = () => opened + COMPACTION_BEFORE_STALE_MS * 20;
    readings.push({ usedTokens: 195_460, windowTokens: 512_000, observedAtMs: Date.now() });
    bookkeeping.contextUsageObserved("agent-a");
  });
  Date.now = originalNow;
  const written = line(records);
  expect(written?.tokens_before_stale).toBeUndefined();
  expect(written?.tokens_before_age_ms).toBeLessThan(COMPACTION_BEFORE_STALE_MS);
});
