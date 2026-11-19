import { expect, test } from "bun:test";
import { compactionTokens } from "#src/agent-runtime/runtime-phases";
import type { ActivityLaunch } from "#src/daemon-runtime/activity-launch";
import type { ActivityDraft } from "#src/daemon-runtime/agent-activity-publisher";
import { PhaseBookkeeping } from "#src/daemon-runtime/phase-bookkeeping";
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

const runtimeEstimates = { runtimePreTokens: 29_578, runtimePostTokens: 9_690 };

function line(records: Array<{ properties: Record<string, unknown> }>) {
  return records
    .map((record) => record.properties)
    .find((properties) => properties.event === "agent.runtime.compaction_tokens");
}

test("a finished compaction event's runtime estimates stay apart from the token numbers it reports", () => {
  expect(
    compactionTokens({ type: "compaction-finished", ...runtimeEstimates, windowTokens: 512_000 }),
  ).toEqual({ ...runtimeEstimates, windowTokens: 512_000 });
});

test("the runtime's own estimates are logged on the line but never become the after number", async () => {
  const { bookkeeping } = subject([
    { usedTokens: 29_575, windowTokens: 512_000, observedAtMs: Date.now() - 60_000 },
  ]);
  const { records } = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", launch, undefined);
    bookkeeping.finish("compaction", "agent-a", launch, undefined, runtimeEstimates);
    bookkeeping.turnEnded("agent-a");
  });
  const written = line(records);
  expect(written).toMatchObject({
    runtime_pre_tokens: 29_578,
    runtime_post_tokens: 9_690,
    tokens_before: 29_575,
    tokens_after_unavailable: "no_reading_after_compaction",
  });
  expect(written?.tokens_after).toBeUndefined();
  expect(written?.tokens_source).toBeUndefined();
});

test("a reading taken after the compaction is still the after number when the runtime gave estimates", async () => {
  const { bookkeeping, readings } = subject([
    { usedTokens: 29_575, windowTokens: 512_000, observedAtMs: Date.now() - 60_000 },
  ]);
  const { records } = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", launch, undefined);
    bookkeeping.finish("compaction", "agent-a", launch, undefined, runtimeEstimates);
    readings.push({ usedTokens: 30_576, windowTokens: 512_000, observedAtMs: Date.now() + 1 });
    bookkeeping.contextUsageObserved("agent-a");
  });
  expect(line(records)).toMatchObject({
    tokens_after: 30_576,
    tokens_source: "reading",
    runtime_post_tokens: 9_690,
  });
});
