import { expect, test } from "bun:test";
import { PhaseBookkeeping } from "#src/daemon-runtime/phase-bookkeeping";
import type { ActivityLaunch } from "#src/daemon-runtime/activity-launch";
import type { ActivityDraft } from "#src/daemon-runtime/agent-activity-publisher";
import { captureDaemonLogs } from "./log-capture";

const launch = { launchId: "launch-a", clientSeq: 0, stopping: false } as ActivityLaunch;

type Reading = { usedTokens: number; windowTokens: number; observedAtMs: number };

/** Bookkeeping over a reading the test moves, the way a runtime reports one: the last reading
 * before a compaction is still the one on record when the compaction ends unless a new one
 * arrived in between. */
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

function compactionLine(records: Array<{ properties: Record<string, unknown> }>) {
  return records
    .map((record) => record.properties)
    .find((properties) => properties.event === "agent.runtime.compaction_tokens");
}

test("a compaction with only the pre-compaction reading reports no after number", async () => {
  // Claude Code and Codex have no numbers of their own for a compaction: the line falls back to
  // the last context reading. Taking it as the "after" value would say the compaction freed
  // nothing, when in fact nothing was read after it (task #3).
  const { bookkeeping } = subject([
    { usedTokens: 112_630, windowTokens: 200_000, observedAtMs: Date.now() - 60_000 },
  ]);
  const { records } = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", launch, undefined);
    bookkeeping.finish("compaction", "agent-a", launch, undefined);
  });
  const line = compactionLine(records);
  expect(line).toMatchObject({ tokens_before: 112_630, window_tokens: 200_000 });
  expect(line?.tokens_after).toBeUndefined();
  expect(line?.tokens_after_unavailable).toBe("no_reading_after_compaction");
});

test("a reading already on record when the compaction opened is not its result", async () => {
  // The same reading, timestamp included: only a sample newer than the one the compaction saw
  // counts, so a frozen clock cannot turn the starting count into the ending one.
  const frozen = Date.now();
  const originalNow = Date.now;
  Date.now = () => frozen;
  try {
    const { bookkeeping } = subject([
      { usedTokens: 112_630, windowTokens: 200_000, observedAtMs: frozen },
    ]);
    const { records } = await captureDaemonLogs(async () => {
      bookkeeping.start("compaction", "agent-a", launch, undefined);
      bookkeeping.finish("compaction", "agent-a", launch, undefined);
    });
    const line = compactionLine(records);
    expect(line?.tokens_after).toBeUndefined();
    expect(line?.tokens_after_unavailable).toBe("no_reading_after_compaction");
    expect(line?.tokens_source).toBeUndefined();
  } finally {
    Date.now = originalNow;
  }
});

test("a reading observed after the compaction started is the after number", async () => {
  const { bookkeeping, readings } = subject([
    { usedTokens: 112_630, windowTokens: 200_000, observedAtMs: Date.now() - 60_000 },
  ]);
  const { records } = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", launch, undefined);
    readings.push({ usedTokens: 40_369, windowTokens: 200_000, observedAtMs: Date.now() });
    bookkeeping.finish("compaction", "agent-a", launch, undefined);
  });
  const line = compactionLine(records);
  expect(line).toMatchObject({
    tokens_before: 112_630,
    tokens_after: 40_369,
    tokens_source: "reading",
  });
  expect(line?.tokens_after_unavailable).toBeUndefined();
});

test("a reading taken while the compaction runs, still at the old count, is not the result", async () => {
  // A reading arrives at a turn boundary, so one that lands mid-compaction describes the context
  // that is being compacted: it is new, and it is still the starting size.
  const { bookkeeping, readings } = subject([
    { usedTokens: 112_630, windowTokens: 200_000, observedAtMs: Date.now() - 60_000 },
  ]);
  const { records } = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", launch, undefined);
    readings.push({ usedTokens: 112_630, windowTokens: 200_000, observedAtMs: Date.now() });
    bookkeeping.finish("compaction", "agent-a", launch, undefined);
  });
  const line = compactionLine(records);
  expect(line?.tokens_after).toBeUndefined();
  expect(line?.tokens_after_unavailable).toBe("no_reading_after_compaction");
});

test("a runtime that never emits a reading says so, instead of claiming one was missed", async () => {
  // Only some runtimes report context usage at all; for the rest the marker names the capability,
  // not a gap in detection (task #3).
  const { bookkeeping } = subject([]);
  const { records } = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", launch, undefined);
    bookkeeping.finish("compaction", "agent-a", launch, undefined);
  });
  expect(compactionLine(records)?.tokens_after_unavailable).toBe("runtime_reports_no_readings");
});
