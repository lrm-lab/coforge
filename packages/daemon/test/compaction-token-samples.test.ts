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
    bookkeeping.turnEnded("agent-a");
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
      bookkeeping.turnEnded("agent-a");
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
    bookkeeping.contextUsageObserved("agent-a");
    bookkeeping.turnEnded("agent-a");
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
    bookkeeping.turnEnded("agent-a");
  });
  expect(compactionLine(records)?.tokens_after_unavailable).toBe("runtime_reports_no_readings");
});

test("the line waits for the reading Claude Code reports at the turn's end", async () => {
  // Claude ends the compaction at its boundary and only reports the context at the top-level
  // result, so writing the line at the boundary always said the number was unavailable — for the
  // runtime that produces readings most reliably (task #16).
  const { bookkeeping, readings } = subject([
    { usedTokens: 112_630, windowTokens: 200_000, observedAtMs: Date.now() - 60_000 },
  ]);
  const { records } = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", launch, undefined);
    bookkeeping.finish("compaction", "agent-a", launch, undefined);
    readings.push({ usedTokens: 40_369, windowTokens: 200_000, observedAtMs: Date.now() });
    bookkeeping.contextUsageObserved("agent-a");
  });
  expect(compactionLine(records)).toMatchObject({
    outcome: "finished",
    tokens_before: 112_630,
    tokens_after: 40_369,
    window_tokens: 200_000,
    tokens_source: "reading",
  });
});

test("a turn that ends with no reading writes the held line, saying what it lacks", async () => {
  // The reading never came: the line is worth having, but not at the price of a number nobody read.
  const { bookkeeping } = subject([
    { usedTokens: 112_630, windowTokens: 200_000, observedAtMs: Date.now() - 60_000 },
  ]);
  const { records } = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", launch, undefined);
    bookkeeping.finish("compaction", "agent-a", launch, undefined);
    bookkeeping.turnEnded("agent-a");
    bookkeeping.turnEnded("agent-a");
  });
  const lines = records.filter(
    (record) => record.properties.event === "agent.runtime.compaction_tokens",
  );
  expect(lines).toHaveLength(1);
  expect(compactionLine(records)?.tokens_after_unavailable).toBe("no_reading_after_compaction");
});

test("a compaction that starts before the reading arrives writes the held line first", async () => {
  // The older compaction happened either way; a second one must not overwrite its line.
  const { bookkeeping } = subject([
    { usedTokens: 112_630, windowTokens: 200_000, observedAtMs: Date.now() - 60_000 },
  ]);
  const { records } = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", launch, undefined);
    bookkeeping.finish("compaction", "agent-a", launch, undefined);
    bookkeeping.start("compaction", "agent-a", launch, undefined);
  });
  const lines = records.filter(
    (record) => record.properties.event === "agent.runtime.compaction_tokens",
  );
  expect(lines).toHaveLength(1);
  expect(compactionLine(records)?.tokens_after_unavailable).toBe("no_reading_after_compaction");
});

test("a zero reading is not a compaction result, even when it arrives after the start", async () => {
  // Codex writes a zero around a compaction. A compacted context still holds its summary, so a
  // zero is a sentinel and logging it would say the compaction freed the whole context.
  const { bookkeeping, readings } = subject([
    { usedTokens: 112_630, windowTokens: 200_000, observedAtMs: Date.now() - 60_000 },
  ]);
  const { records } = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", launch, undefined);
    bookkeeping.finish("compaction", "agent-a", launch, undefined);
    readings.push({ usedTokens: 0, windowTokens: 200_000, observedAtMs: Date.now() });
    bookkeeping.contextUsageObserved("agent-a");
    bookkeeping.turnEnded("agent-a");
  });
  expect(compactionLine(records)?.tokens_after).toBeUndefined();
  expect(compactionLine(records)?.tokens_after_unavailable).toBe("no_reading_after_compaction");
});

test("a reading that grew past the count the compaction opened on is still its result", async () => {
  // Claude Code only reads at a turn's end, so the count the compaction opened on is the previous
  // turn's — the turn it runs in may well grow past it after compacting. The reading that arrives
  // once the compaction has ended is a sample taken after it, which is what the line wants.
  const { bookkeeping, readings } = subject([
    { usedTokens: 25_000, windowTokens: 200_000, observedAtMs: Date.now() - 600_000 },
  ]);
  const { records } = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", launch, undefined);
    bookkeeping.finish("compaction", "agent-a", launch, undefined);
    readings.push({ usedTokens: 40_369, windowTokens: 200_000, observedAtMs: Date.now() });
    bookkeeping.contextUsageObserved("agent-a");
    bookkeeping.turnEnded("agent-a");
  });
  const lines = records.filter(
    (record) => record.properties.event === "agent.runtime.compaction_tokens",
  );
  expect(lines).toHaveLength(1);
  expect(compactionLine(records)).toMatchObject({
    tokens_before: 25_000,
    tokens_after: 40_369,
    tokens_source: "reading",
  });
});

test("a compaction the daemon only infers still waits for the reading", async () => {
  // No boundary arrived; the turn went on and its reading is the only number there will be.
  const { bookkeeping, readings } = subject([
    { usedTokens: 112_630, windowTokens: 200_000, observedAtMs: Date.now() - 60_000 },
  ]);
  const { records } = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", launch, undefined);
    bookkeeping.inferCompactionFinished("agent-a", launch, undefined, {
      inferredFrom: "resumed output",
    });
    readings.push({ usedTokens: 40_369, windowTokens: 200_000, observedAtMs: Date.now() });
    bookkeeping.contextUsageObserved("agent-a");
  });
  expect(compactionLine(records)).toMatchObject({
    outcome: "inferred",
    tokens_after: 40_369,
    tokens_source: "reading",
  });
});

test("a held line says when its compaction ended and how long it waited", async () => {
  // The line is written at the turn's end, not at the compaction's: the daily report buckets it by
  // the compaction, so both times travel with it (raft, task #16).
  const { bookkeeping, readings } = subject([
    { usedTokens: 112_630, windowTokens: 200_000, observedAtMs: Date.now() - 60_000 },
  ]);
  const endedAt = Date.now();
  const originalNow = Date.now;
  Date.now = () => endedAt;
  let line: Record<string, unknown> | undefined;
  try {
    const { records } = await captureDaemonLogs(async () => {
      bookkeeping.start("compaction", "agent-a", launch, undefined);
      bookkeeping.finish("compaction", "agent-a", launch, undefined);
      Date.now = () => endedAt + 4_000;
      readings.push({ usedTokens: 40_369, windowTokens: 200_000, observedAtMs: endedAt + 3_000 });
      bookkeeping.contextUsageObserved("agent-a");
    });
    line = compactionLine(records);
  } finally {
    Date.now = originalNow;
  }
  expect(line?.compaction_ended_at).toBe(new Date(endedAt).toISOString());
  expect(line?.delayed_ms).toBe(4_000);
});

test("a line written as the compaction ends carries no delay", async () => {
  const { bookkeeping } = subject([
    { usedTokens: 112_630, windowTokens: 200_000, observedAtMs: Date.now() - 60_000 },
  ]);
  const endedAt = Date.now();
  const originalNow = Date.now;
  Date.now = () => endedAt;
  let line: Record<string, unknown> | undefined;
  try {
    const { records } = await captureDaemonLogs(async () => {
      bookkeeping.start("compaction", "agent-a", launch, undefined);
      bookkeeping.finish("compaction", "agent-a", launch, undefined, { tokensAfter: 40_369 });
    });
    line = compactionLine(records);
  } finally {
    Date.now = originalNow;
  }
  expect(line?.compaction_ended_at).toBe(new Date(endedAt).toISOString());
  expect(line?.delayed_ms).toBeUndefined();
});
