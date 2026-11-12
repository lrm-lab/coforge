import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import type { AgentActivity, AgentStatus } from "@lrm/coforge-sdk/internal";
import { RedisAgentDisplay } from "#src/server/agents/agent-display.server";
import { AGENT_STATUS_LEASE_MS } from "#src/server/agents/agent-status.server";

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

describe.skipIf(!redisServer)("RedisAgentDisplay credential hold (task #90)", () => {
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
  const signedOut = (sequence: number) =>
    activity(sequence, "runtime_error", {
      level: "error",
      detail: "Runtime not signed in",
      runtimeError: {
        errorClass: "AuthenticationError",
        errorReason: "auth_failed",
        fingerprint: "fp-auth",
        requiredAction: "user_reauth",
      },
    });

  test("a credential the Daemon holds the live Agent on shows while it runs, past lease renewals", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    const failed = await subject.observeActivity(signedOut(2), fence);
    expect(failed?.activityKind).toBe("error");
    expect(failed?.stopReason).toBe("auth_failed");
    expect(failed?.stopMessage).toBe("Runtime not signed in");
    // The same process renewing its lease is no news: the hold still waits for a person.
    now += AGENT_STATUS_LEASE_MS / 2;
    const renewed = await subject.observeStatus(status(3));
    expect(renewed?.stopReason).toBe("auth_failed");
    // The next turn's output ends it, as it ends the Daemon's hold.
    const working = await subject.observeActivity(activity(4, "model_request_started"), fence);
    expect(working?.stopReason).toBeNull();
  });

  test("the row that may close the failed turn keeps the held reason", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(signedOut(2), fence);
    const idle = await subject.observeActivity(activity(3, "idle"), fence);
    expect(idle?.activityKind).toBe("online");
    expect(idle?.stopReason).toBe("auth_failed");
    const background = await subject.observeActivity(activity(4, "subagent_activity"), fence);
    expect(background?.stopReason).toBe("auth_failed");
    const thinking = await subject.observeActivity(activity(5, "thinking_started"), fence);
    expect(thinking?.stopReason).toBeNull();
  });

  test("an idle row after a failure that is no hold still clears it", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(
      activity(2, "runtime_error", {
        level: "error",
        runtimeError: {
          errorClass: "RuntimeFailure",
          errorReason: "runtime_failure",
          fingerprint: "f",
        },
      }),
      fence,
    );
    await subject.observeActivity(activity(3, "idle"), fence);
    await subject.observeStatus(status(4, "inactive"));
    expect((await subject.snapshot(scope)).stopReason).toBeNull();
  });

  test("the Daemon's restored report ends the held reason and its error row", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(signedOut(2), fence);
    // Another failure's report changes nothing.
    expect(await subject.endHeldStop(scope, "billing_exhausted")).toBeUndefined();
    const ended = await subject.endHeldStop(scope, "auth_failed");
    expect(ended?.stopReason).toBeNull();
    expect(ended?.activityKind).toBe("online");
    // Once over, a repeat is no news.
    expect(await subject.endHeldStop(scope, "auth_failed")).toBeUndefined();
  });

  test("a heartbeat keeps the held reason", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(signedOut(2), fence);
    const beat = await subject.observeActivity(
      activity(3, "model_request_started", { isHeartbeat: true }),
      fence,
    );
    expect(beat?.stopReason).toBe("auth_failed");
  });

  test("an exhausted balance is held the same way", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    const failed = await subject.observeActivity(
      activity(2, "runtime_error", {
        level: "error",
        runtimeError: {
          errorClass: "BillingError",
          errorReason: "billing_exhausted",
          fingerprint: "fp-bill",
        },
      }),
      fence,
    );
    expect(failed?.stopReason).toBe("billing_exhausted");
  });

  test("a fresh process ends the held reason", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(signedOut(2), fence);
    await subject.observeStatus(status(3, "inactive"));
    expect((await subject.snapshot(scope)).stopReason).toBe("auth_failed");
    expect((await subject.observeStatus(status(4)))?.stopReason).toBeNull();
    // Another Daemon instance taking over is a fresh process too.
    await subject.observeActivity(signedOut(5), fence);
    const other = await subject.observeStatus(
      status(1, "active", { daemonInstanceId: "daemon-b", observedAtMs: 10_000 }),
    );
    expect(other?.stopReason).toBeNull();
  });

  test("a failure that is not a hold still reports only once the Agent is offline", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    const failed = await subject.observeActivity(
      activity(2, "runtime_error", {
        level: "error",
        runtimeError: {
          errorClass: "RuntimeFailure",
          errorReason: "runtime_failure",
          fingerprint: "fp-run",
        },
      }),
      fence,
    );
    expect(failed?.stopReason).toBeNull();
  });
});
