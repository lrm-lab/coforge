import { expect, test } from "bun:test";
import { AgentUsageReport } from "#src/daemon-runtime/agent-usage-report";
import type { PublishedActivityLaunch } from "#src/daemon-runtime/agent-activity-publisher";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

const launch = { launchId: "launch-a", clientSeq: 0 } as PublishedActivityLaunch;

/** The report over a recording sender, so the test reads what the cloud would receive. */
function subject({ withSession = true }: { withSession?: boolean } = {}) {
  const sessionId = withSession ? "session-1" : undefined;
  const sent: Array<Record<string, unknown>> = [];
  const report = new AgentUsageReport({
    sessionId: () => sessionId,
    envelope: () => ({
      protocolMajor: 1,
      requestId: "request-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
    }),
    daemonInstanceId: () => "daemon-1",
    recordClientSeq: () => {},
    sendContextUsage: (payload) => {
      sent.push(payload as unknown as Record<string, unknown>);
    },
    sendServiceTier: () => {},
  });
  return { report, sent };
}

test("a reading keeps the time the runtime sampled it, not when the daemon read the event", () => {
  // Claude Code timestamps its result record; the daemon's own clock is when it got around to it,
  // and a compaction told apart by receipt times would credit the wrong turn (task #16).
  const { report, sent } = subject();
  report.contextUsage(
    "agent-a",
    launch,
    RUNTIME_PROVIDER.CLAUDE_CODE,
    40_369,
    200_000,
    "2026-11-10T08:59:58.000Z",
  );
  expect(sent[0]).toMatchObject({
    usedTokens: 40_369,
    observedAtMs: Date.parse("2026-11-10T08:59:58.000Z"),
  });
  expect(report.lastContextUsage("agent-a")?.observedAtMs).toBe(
    Date.parse("2026-11-10T08:59:58.000Z"),
  );
});

test("a runtime that gives no time falls back to the daemon's clock", () => {
  const { report, sent } = subject();
  const before = Date.now();
  report.contextUsage("agent-a", launch, RUNTIME_PROVIDER.CODEX, 1_000, 200_000);
  const observedAtMs = sent[0]?.observedAtMs as number;
  expect(observedAtMs).toBeGreaterThanOrEqual(before);
  expect(observedAtMs).toBeLessThanOrEqual(Date.now());
});

test("an unchanged reading is not re-sent, but still counts as a newer sample", () => {
  // The count is what the cloud is told; the sampling time is what a held compaction line reads.
  const { report, sent } = subject();
  report.contextUsage(
    "agent-a",
    launch,
    RUNTIME_PROVIDER.CLAUDE_CODE,
    1_000,
    200_000,
    "2026-11-10T08:00:00.000Z",
  );
  const recorded = report.contextUsage(
    "agent-a",
    launch,
    RUNTIME_PROVIDER.CLAUDE_CODE,
    1_000,
    200_000,
    "2026-11-10T08:05:00.000Z",
  );
  expect(sent).toHaveLength(1);
  expect(recorded).toBe(true);
  expect(report.lastContextUsage("agent-a")?.observedAtMs).toBe(
    Date.parse("2026-11-10T08:05:00.000Z"),
  );
});

test("a reading with no session to attach to is not recorded", () => {
  const { report, sent } = subject({ withSession: false });
  expect(report.contextUsage("agent-a", launch, RUNTIME_PROVIDER.CLAUDE_CODE, 1_000, 200_000)).toBe(
    false,
  );
  expect(sent).toHaveLength(0);
  expect(report.lastContextUsage("agent-a")).toBeUndefined();
});

test("a timestamp that parses to zero is not forwarded to the wire", () => {
  // The report's codec rejects a non-positive observedAtMs, and this send is fire-and-forget: a
  // provider record carrying an epoch timestamp must not throw out of the event path (task #16).
  const { report, sent } = subject();
  const before = Date.now();
  report.contextUsage(
    "agent-a",
    launch,
    RUNTIME_PROVIDER.CLAUDE_CODE,
    1_000,
    200_000,
    "1970-01-01T00:00:00.000Z",
  );
  expect(sent[0]?.observedAtMs as number).toBeGreaterThanOrEqual(before);
});
