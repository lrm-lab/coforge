import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import type { AgentActivity, AgentStatus } from "@lrm/coforge-sdk/internal";
import { RedisAgentDisplay } from "#src/server/agents/agent-display.server";

const redisServer = Bun.which("redis-server");
const port = 20_000 + Math.floor(Math.random() * 20_000);
const url = `redis://127.0.0.1:${port}`;
let process: ReturnType<typeof Bun.spawn> | undefined;
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

describe.skipIf(!redisServer)("RedisAgentDisplay stop reason", () => {
  beforeAll(async () => {
    process = Bun.spawn(
      [redisServer!, "--port", String(port), "--save", "", "--appendonly", "no"],
      {
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    redis = new RedisClient(url);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await redis.send("PING", []);
        return;
      } catch {
        await Bun.sleep(10);
      }
    }
    throw new Error("isolated redis-server did not become ready");
  });

  afterAll(async () => {
    redis?.close();
    process?.kill();
    await process?.exited;
  });

  const display = () => new RedisAgentDisplay(redis, () => now);

  test("keeps a runtime stop reason on the offline display until the next active process", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    const failed = await subject.observeActivity(
      activity(2, "runtime_error", {
        level: "error",
        runtimeError: {
          errorClass: "ProviderQuotaError",
          errorReason: "billing_exhausted",
          fingerprint: "fp-1",
        },
      }),
      fence,
    );
    expect(failed?.activityKind).toBe("error");
    // Still online: the reason only reports once the process is actually offline.
    expect(failed?.stopReason).toBeNull();
    await subject.observeStatus(status(3, "inactive"));
    const offline = await subject.snapshot(scope);
    expect(offline.activityKind).toBe("offline");
    expect(offline.stopReason).toBe("billing_exhausted");
    await subject.observeStatus(status(4));
    expect((await subject.snapshot(scope)).stopReason).toBeNull();
  });

  test("an Activity without a runtime error leaves no stop reason", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(activity(2, "runtime_error", { level: "error" }), fence);
    await subject.observeStatus(status(3, "inactive"));
    expect((await subject.snapshot(scope)).stopReason).toBeNull();
  });
});
