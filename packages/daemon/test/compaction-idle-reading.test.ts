import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import {
  IDLE_COMPACTION_READING_CAP_MS,
  PhaseBookkeeping,
} from "#src/daemon-runtime/phase-bookkeeping";
import type { ActivityLaunch } from "#src/daemon-runtime/activity-launch";
import type { ActivityDraft } from "#src/daemon-runtime/agent-activity-publisher";
import { captureDaemonLogs } from "./log-capture";

const nativeLaunch = { launchId: "launch-a", clientSeq: 0, stopping: false } as ActivityLaunch;
const idleLaunch = { ...nativeLaunch, idleCompaction: true } as ActivityLaunch;
type Reading = { usedTokens: number; windowTokens: number; observedAtMs: number };
type Properties = Record<string, unknown>;

function subject() {
  const readings: Reading[] = [
    { usedTokens: 252_000, windowTokens: 512_000, observedAtMs: Date.now() - 60_000 },
  ];
  const bookkeeping = new PhaseBookkeeping({
    launchFor: () => nativeLaunch,
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

const lines = (records: Array<{ properties: Properties }>) =>
  records
    .map((record) => record.properties)
    .filter((properties) => properties.event === "agent.runtime.compaction_tokens");

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("an idle compaction's line is not written when its own turn ends", async () => {
  const { bookkeeping } = subject();
  const { records } = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", idleLaunch, undefined);
    bookkeeping.finish("compaction", "agent-a", idleLaunch, undefined);
    bookkeeping.turnEnded("agent-a");
  });
  expect(lines(records)).toHaveLength(0);
});

test("the next reading, taken after more work, is its after number and says so", async () => {
  const { bookkeeping, readings } = subject();
  const { records } = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", idleLaunch, undefined);
    bookkeeping.finish("compaction", "agent-a", idleLaunch, undefined);
    bookkeeping.turnEnded("agent-a");
    jest.advanceTimersByTime(10 * 60_000);
    readings.push({ usedTokens: 61_000, windowTokens: 512_000, observedAtMs: Date.now() });
    bookkeeping.contextUsageObserved("agent-a");
  });
  const [written] = lines(records);
  expect(written).toMatchObject({
    idle_compaction: true,
    tokens_before: 252_000,
    tokens_after: 61_000,
    tokens_source: "reading_after_more_work",
  });
  expect(written?.delayed_ms).toBeGreaterThanOrEqual(10 * 60_000);
  expect(lines(records)).toHaveLength(1);
});

test("a native compaction's line is still written when its turn ends, and is not marked idle", async () => {
  const { bookkeeping } = subject();
  const { records } = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", nativeLaunch, undefined);
    bookkeeping.finish("compaction", "agent-a", nativeLaunch, undefined);
    bookkeeping.turnEnded("agent-a");
  });
  const [written] = lines(records);
  expect(written?.tokens_after_unavailable).toBe("no_reading_after_compaction");
  expect(written).not.toHaveProperty("idle_compaction");
});

async function idleLineAfter(ms: number) {
  const { bookkeeping } = subject();
  const { records } = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", idleLaunch, undefined);
    bookkeeping.finish("compaction", "agent-a", idleLaunch, undefined);
    bookkeeping.turnEnded("agent-a");
    jest.advanceTimersByTime(ms);
  });
  return lines(records);
}

test("an idle line is still held one millisecond before the cap", async () => {
  expect(await idleLineAfter(IDLE_COMPACTION_READING_CAP_MS - 1)).toHaveLength(0);
});

test("an idle line that never gets a reading is written at the cap, saying why", async () => {
  const [written] = await idleLineAfter(IDLE_COMPACTION_READING_CAP_MS);
  expect(written).toMatchObject({
    idle_compaction: true,
    tokens_after_unavailable: "no_reading_before_cap",
  });
  expect(written?.tokens_after).toBeUndefined();
});

test("a held idle line is written, not lost, when the next compaction opens or the Agent is disposed", async () => {
  const { bookkeeping } = subject();
  const opened = await captureDaemonLogs(async () => {
    bookkeeping.start("compaction", "agent-a", idleLaunch, undefined);
    bookkeeping.finish("compaction", "agent-a", idleLaunch, undefined);
    bookkeeping.start("compaction", "agent-a", nativeLaunch, undefined);
  });
  expect(lines(opened.records)).toHaveLength(1);
  const disposed = await captureDaemonLogs(async () => {
    bookkeeping.finish("compaction", "agent-a", nativeLaunch, undefined);
    bookkeeping.start("compaction", "agent-b", idleLaunch, undefined);
    bookkeeping.finish("compaction", "agent-b", idleLaunch, undefined);
    bookkeeping.dispose("agent-b");
  });
  expect(lines(disposed.records).some((line) => line.agent_id === "agent-b")).toBe(true);
});
