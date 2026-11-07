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
          providerMessage: "Your credit balance is too low.",
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
    expect(offline.stopDetail).toBe("Your credit balance is too low.");
    await subject.observeStatus(status(4));
    const back = await subject.snapshot(scope);
    expect(back.stopReason).toBeNull();
    expect(back.stopDetail).toBeNull();
  });

  test("the provider's words go with the reason once a non-error Activity moves on", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(
      activity(2, "runtime_error", {
        level: "error",
        runtimeError: {
          errorClass: "ProviderQuotaError",
          errorReason: "billing_exhausted",
          fingerprint: "fp-1",
          providerMessage: "Your credit balance is too low.",
        },
      }),
      fence,
    );
    await subject.observeActivity(activity(3, "model_request_started"), fence);
    await subject.observeStatus(status(4, "inactive"));
    const offline = await subject.snapshot(scope);
    expect(offline.activityKind).toBe("offline");
    expect(offline.stopReason).toBeNull();
    expect(offline.stopDetail).toBeNull();
  });

  test("a failure from an older daemon keeps its reason and no words", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(
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
    await subject.observeStatus(status(3, "inactive"));
    const offline = await subject.snapshot(scope);
    expect(offline.stopReason).toBe("billing_exhausted");
    expect(offline.stopDetail).toBeNull();
  });

  test("an Activity without a runtime error leaves no stop reason", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(activity(2, "runtime_error", { level: "error" }), fence);
    await subject.observeStatus(status(3, "inactive"));
    expect((await subject.snapshot(scope)).stopReason).toBeNull();
  });

  test("a transient runtime error clears once the Agent's Activity moves on", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(
      activity(2, "runtime_error", {
        level: "error",
        runtimeError: {
          errorClass: "RateLimitError",
          errorReason: "rate_limited",
          fingerprint: "fp-2",
        },
      }),
      fence,
    );
    // The Agent kept working past the error, so it did not stop for it.
    await subject.observeActivity(activity(3, "model_response_started"), fence);
    await subject.observeStatus(status(4, "inactive"));
    expect((await subject.snapshot(scope)).stopReason).toBeNull();
  });

  test("frames after inactive cannot reach the reducer, so the reason survives", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(
      activity(2, "runtime_error", {
        level: "error",
        runtimeError: {
          errorClass: "ProviderQuotaError",
          errorReason: "billing_exhausted",
          fingerprint: "fp-4",
        },
      }),
      fence,
    );
    await subject.observeStatus(status(3, "inactive"));
    // A late heartbeat or probe reply lands after the process went inactive: the reducer
    // rejects it before it can touch stopReason.
    const late = await subject.observeActivity(
      activity(4, "runtime_progress", { isHeartbeat: true }),
      fence,
    );
    expect(late).toBeUndefined();
    expect((await subject.snapshot(scope)).stopReason).toBe("billing_exhausted");
  });

  test("an offline Agent records a new launch's failure reason", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeStatus(status(2, "inactive"));
    // A relaunch fails: the daemon reports inactive, then the error Activity under the
    // failed launch's own id. The offline gate must let this one reason through.
    await subject.observeActivity(
      activity(3, "runtime_error", {
        launchId: "launch-b",
        level: "error",
        runtimeError: {
          errorClass: "RuntimeUnavailableError",
          errorReason: "runtime_login_required",
          fingerprint: "fp-login",
          providerMessage: "Cursor CLI is not signed in on this Computer",
        },
      }),
      { daemonInstanceId: "daemon-a", launchId: "launch-b" },
    );
    const offline = await subject.snapshot(scope);
    expect(offline.activityKind).toBe("offline");
    expect(offline.stopReason).toBe("runtime_login_required");
    expect(offline.stopDetail).toBe("Cursor CLI is not signed in on this Computer");
  });

  test("a never-launched Agent records its first launch's failure reason", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1, "inactive"));
    await subject.observeActivity(
      activity(2, "runtime_error", {
        launchId: "launch-b",
        level: "error",
        runtimeError: {
          errorClass: "RuntimeUnavailableError",
          errorReason: "runtime_login_required",
          fingerprint: "fp-login",
        },
      }),
      { daemonInstanceId: "daemon-a", launchId: "launch-b" },
    );
    const offline = await subject.snapshot(scope);
    expect(offline.stopReason).toBe("runtime_login_required");
    expect(offline.stopDetail).toBeNull();
  });

  test("a successful relaunch clears the recorded launch-failure reason", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeStatus(status(2, "inactive"));
    await subject.observeActivity(
      activity(3, "runtime_error", {
        launchId: "launch-b",
        level: "error",
        runtimeError: {
          errorClass: "RuntimeUnavailableError",
          errorReason: "runtime_login_required",
          fingerprint: "fp-login",
          providerMessage: "Cursor CLI is not signed in on this Computer",
        },
      }),
      { daemonInstanceId: "daemon-a", launchId: "launch-b" },
    );
    await subject.observeStatus(status(4));
    const back = await subject.snapshot(scope);
    expect(back.activityKind).toBe("online");
    expect(back.stopReason).toBeNull();
    expect(back.stopDetail).toBeNull();
  });

  test("a stale launch's late error frame does not overwrite the recorded reason", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1, "inactive"));
    await subject.observeActivity(
      activity(2, "runtime_error", {
        launchId: "launch-b",
        level: "error",
        observedAtMs: 200,
        runtimeError: {
          errorClass: "RuntimeUnavailableError",
          errorReason: "runtime_login_required",
          fingerprint: "fp-login",
        },
      }),
      { daemonInstanceId: "daemon-a", launchId: "launch-b" },
    );
    // An older launch's error frame lands late: older observedAt, so it must not win.
    await subject.observeActivity(
      activity(3, "runtime_error", {
        launchId: "launch-a",
        level: "error",
        observedAtMs: 50,
        runtimeError: {
          errorClass: "ProviderQuotaError",
          errorReason: "billing_exhausted",
          fingerprint: "fp-old",
        },
      }),
      { daemonInstanceId: "daemon-a", launchId: "launch-a" },
    );
    expect((await subject.snapshot(scope)).stopReason).toBe("runtime_login_required");
  });

  test("a settled control failure records its reason on the offline display", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1, "inactive"));
    const recorded = await subject.recordStopReason(scope, "runtime_login_required");
    expect(recorded?.stopReason).toBe("runtime_login_required");
    expect(recorded?.stopDetail).toBeNull();
    expect((await subject.snapshot(scope)).stopReason).toBe("runtime_login_required");
  });

  test("a control-recorded reason keeps the provider words an Activity already wrote", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(
      activity(2, "runtime_error", {
        level: "error",
        runtimeError: {
          errorClass: "RuntimeUnavailableError",
          errorReason: "runtime_login_required",
          fingerprint: "fp-login",
          providerMessage: "Cursor CLI is not signed in on this Computer",
        },
      }),
      fence,
    );
    await subject.observeStatus(status(3, "inactive"));
    // The control result settles after the Activity: same reason, no words of its own.
    await subject.recordStopReason(scope, "runtime_login_required");
    const offline = await subject.snapshot(scope);
    expect(offline.stopReason).toBe("runtime_login_required");
    expect(offline.stopDetail).toBe("Cursor CLI is not signed in on this Computer");
  });

  test("a different settled reason replaces the recorded one and its words", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1, "inactive"));
    await subject.recordStopReason(scope, "runtime_login_required", "Cursor CLI is not signed in");
    await subject.recordStopReason(scope, "billing_exhausted");
    const offline = await subject.snapshot(scope);
    expect(offline.stopReason).toBe("billing_exhausted");
    expect(offline.stopDetail).toBeNull();
  });

  test("re-recording the same reason changes nothing", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1, "inactive"));
    await subject.recordStopReason(scope, "runtime_login_required");
    const again = await subject.recordStopReason(scope, "runtime_login_required");
    expect(again).toBeUndefined();
  });

  test("a control failure never writes a reason onto a live process", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    const recorded = await subject.recordStopReason(scope, "runtime_login_required");
    expect(recorded).toBeUndefined();
    expect((await subject.snapshot(scope)).stopReason).toBeNull();
  });

  test("an error-kind Activity without a reason keeps the last stop reason", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(
      activity(2, "runtime_error", {
        level: "error",
        runtimeError: {
          errorClass: "ProviderQuotaError",
          errorReason: "billing_exhausted",
          fingerprint: "fp-3",
        },
      }),
      fence,
    );
    await subject.observeActivity(activity(3, "runtime_crashed", { level: "error" }), fence);
    await subject.observeStatus(status(4, "inactive"));
    expect((await subject.snapshot(scope)).stopReason).toBe("billing_exhausted");
  });
});
