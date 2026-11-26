import { describe, expect, test } from "bun:test";
import type { RedisClient } from "bun";
import type { AgentActivity, AgentServiceTier, AgentStatus } from "@lrm/coforge-sdk/internal";
import { RedisAgentDisplay } from "#src/server/agents/agent-display.server";
import { redisServer, useRedisFixture } from "./helpers/redis-fixture";

let redis: RedisClient;
let now = 1_000_000;

const scope = { workspaceId: "workspace-a", computerId: "computer-a", agentId: "agent-a" };
const status = (
  sequence: number,
  state: "active" | "inactive" = "active",
  overrides = {},
): AgentStatus => ({
  protocolMajor: 1,
  requestId: `status-${sequence}`,
  ...scope,
  status: state,
  daemonInstanceId: "daemon-a",
  clientSeq: sequence,
  observedAtMs: sequence * 100,
  ...overrides,
});
const activity = (
  sequence: number,
  detailKind: string,
  overrides = {},
): AgentActivity & { computerId: string } => ({
  protocolMajor: 1,
  requestId: `activity-${sequence}`,
  ...scope,
  detailKind,
  level: "info",
  detail: detailKind,
  observedAtMs: sequence * 100,
  launchId: "launch-a",
  clientSeq: sequence,
  ...overrides,
});
const fence = { daemonInstanceId: "daemon-a", launchId: "launch-a" };
const serviceTier = (sequence: number, overrides = {}): AgentServiceTier => ({
  protocolMajor: 1,
  requestId: `service-tier-${sequence}`,
  ...scope,
  provider: "claude-code",
  launchId: "launch-a",
  sessionId: "native-session",
  requested: true,
  observed: "on",
  observedAtMs: sequence * 100,
  daemonInstanceId: "daemon-a",
  clientSeq: sequence,
  ...overrides,
});

describe.skipIf(!redisServer)("RedisAgentDisplay service tier", () => {
  useRedisFixture((client) => {
    redis = client();
  });

  const display = () => new RedisAgentDisplay(redis, () => now);

  test("puts a service-tier reading and surfaces it only while the process is active", async () => {
    await redis.send("FLUSHDB", []);
    now = 6_500_000;
    const subject = display();
    // No process yet: the reading is stored but never surfaced while offline.
    expect((await subject.putServiceTier(serviceTier(1)))?.fastMode).toBeNull();
    await subject.observeStatus(status(1));
    const put = await subject.putServiceTier(serviceTier(2));
    expect(put?.fastMode).toEqual({ requested: true, observed: "on", observedAtMs: 200 });
    expect((await subject.snapshot(scope)).fastMode).toEqual(put!.fastMode);
  });

  test("keeps the context-window fence: a stale clientSeq is rejected and a dead process clears it", async () => {
    await redis.send("FLUSHDB", []);
    now = 6_600_000;
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.putServiceTier(serviceTier(5, { observed: "off" }));
    // Same daemon instance, non-advancing clientSeq: rejected.
    expect(await subject.putServiceTier(serviceTier(5, { observed: "on" }))).toBeUndefined();
    expect((await subject.snapshot(scope)).fastMode).toMatchObject({ observed: "off" });
    // The process going inactive clears it, exactly as it clears the context-window reading.
    expect((await subject.observeStatus(status(2, "inactive")))?.fastMode).toBeNull();
  });

  test("clears a retired launch's service-tier reading once a newer launch's Activity replaces it", async () => {
    await redis.send("FLUSHDB", []);
    now = 6_700_000;
    const subject = display();
    await subject.observeStatus(status(1));
    // Seed a launch-a Activity so the launch-b Activity below has something to retire.
    await subject.observeActivity(activity(1, "starting"), fence);
    await subject.putServiceTier(serviceTier(1));
    expect((await subject.snapshot(scope)).fastMode).not.toBeNull();
    const fenceB = { daemonInstanceId: "daemon-a", launchId: "launch-b" };
    await subject.observeActivity(
      activity(2, "starting", { launchId: "launch-b", observedAtMs: 100_001 }),
      fenceB,
    );
    expect((await subject.snapshot(scope)).fastMode).toBeNull();
  });
});
