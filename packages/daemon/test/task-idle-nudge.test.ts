import { expect, test } from "bun:test";
import { AgentTransportError } from "#src/connection/agent-transport-error";
import {
  IDLE_NUDGE_UNSUPPORTED_RETRY_MS,
  TaskIdleNudge,
  type TaskIdleNudgePorts,
  type IdleNudgeRequest,
  type IdleNudgeResponse,
} from "#src/daemon-runtime/task-idle-nudge";
import { captureDaemonLogs } from "./log-capture";

/** A test double for the server's idle-nudge route; the real one lands with task #477. */
function harness(
  options: {
    respond?: (
      agentId: string,
      request: IdleNudgeRequest,
    ) => Promise<IdleNudgeResponse | undefined>;
  } & Partial<TaskIdleNudgePorts> = {},
) {
  const { respond, ...overrides } = options;
  const asks: Array<{ agentId: string; request: Record<string, unknown> }> = [];
  const delivered: Array<{ agentId: string; text: string }> = [];
  let idle = true;
  let backgroundTasks = 0;
  let sessionId: string | undefined = "session-1";
  let freshSession = false;
  let now = Date.parse("2026-11-03T12:00:00Z");
  const ports: TaskIdleNudgePorts = {
    ask: async (agentId, request) => {
      asks.push({ agentId, request });
      return respond ? respond(agentId, request) : { send: true, text: "idle reminder" };
    },
    idle: () => idle,
    backgroundTasks: () => backgroundTasks,
    sessionId: () => sessionId,
    freshSession: () => freshSession,
    deliver: async (agentId, text) => {
      delivered.push({ agentId, text });
      return true;
    },
    timeoutMs: 20,
    now: () => now,
    ...overrides,
  };
  return {
    nudge: new TaskIdleNudge(ports),
    asks,
    delivered,
    setIdle: (value: boolean) => (idle = value),
    setBackgroundTasks: (value: number) => (backgroundTasks = value),
    setSession: (value: string | undefined, fresh = false) => {
      sessionId = value;
      freshSession = fresh;
    },
    setFreshSession: (value: boolean) => (freshSession = value),
    advance: (ms: number) => (now += ms),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("an idle Agent is asked once and the reminder is written as idle input", async () => {
  const h = harness();
  h.nudge.maybeAsk("agent-a");
  await settle();
  expect(h.asks).toEqual([{ agentId: "agent-a", request: {} }]);
  expect(h.delivered).toEqual([{ agentId: "agent-a", text: "idle reminder" }]);
});

test("a busy Agent is never asked", async () => {
  const h = harness();
  h.setIdle(false);
  h.nudge.maybeAsk("agent-a");
  await settle();
  expect(h.asks).toEqual([]);
  expect(h.delivered).toEqual([]);
});

test("another idle event while the ask is in flight does not ask again", async () => {
  let release!: (value: { send: boolean }) => void;
  const h = harness({
    respond: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  h.nudge.maybeAsk("agent-a");
  h.nudge.maybeAsk("agent-a");
  await settle();
  expect(h.asks).toHaveLength(1);
  release({ send: false });
  await settle();
  h.nudge.maybeAsk("agent-a");
  await settle();
  expect(h.asks).toHaveLength(2);
});

test("a 404 pauses asking for an hour, then tries again", async () => {
  const h = harness({ respond: async () => undefined });
  h.nudge.maybeAsk("agent-a");
  await settle();
  h.nudge.maybeAsk("agent-b");
  await settle();
  expect(h.asks).toHaveLength(1);

  h.advance(IDLE_NUDGE_UNSUPPORTED_RETRY_MS - 1);
  h.nudge.maybeAsk("agent-a");
  await settle();
  expect(h.asks).toHaveLength(1);

  h.advance(1);
  h.nudge.maybeAsk("agent-a");
  await settle();
  expect(h.asks).toHaveLength(2);
});

test("a reminder is dropped when the Agent picked up work while the ask was in flight", async () => {
  let release!: (value: { send: boolean; text: string }) => void;
  const h = harness({
    respond: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  h.nudge.maybeAsk("agent-a");
  h.setIdle(false);
  release({ send: true, text: "idle reminder" });
  await settle();
  expect(h.delivered).toEqual([]);
});

test("a fresh session is asked with freshSession once per session", async () => {
  const h = harness();
  h.setSession("session-2", true);
  h.nudge.maybeAsk("agent-a");
  await settle();
  h.nudge.maybeAsk("agent-a");
  await settle();
  expect(h.asks.map((ask) => ask.request)).toEqual([{ freshSession: true }, {}]);
});

test("a resumed session is not marked fresh, and background tasks are reported", async () => {
  const h = harness();
  h.setSession("session-2", false);
  h.setBackgroundTasks(2);
  h.nudge.maybeAsk("agent-a");
  await settle();
  expect(h.asks[0]?.request).toEqual({ backgroundTasks: 2 });
});

test("an unanswered ask neither writes nor disables the route", async () => {
  const h = harness({ respond: () => new Promise(() => {}), timeoutMs: 10 });
  h.nudge.maybeAsk("agent-a");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(h.delivered).toEqual([]);
  h.nudge.maybeAsk("agent-a");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(h.asks).toHaveLength(2);
});

const waitForEvent = async (
  records: readonly { properties: Record<string, unknown> }[],
  event: string,
) => {
  for (let i = 0; i < 100 && !records.some((record) => record.properties.event === event); i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
};

test("a failed ask logs its message, not a bare Error name", async () => {
  const { records } = await captureDaemonLogs(async (records) => {
    const h = harness({
      respond: async () => {
        throw new Error("Agent API key is missing");
      },
    });
    h.nudge.maybeAsk("agent-a");
    await waitForEvent(records, "task_idle_nudge:failed");
  });
  const record = records.find((entry) => entry.properties.event === "task_idle_nudge:failed");
  expect(record?.properties.error_message).toBe("Agent API key is missing");
});

test("a transport ask failure logs its failure class and upstream status", async () => {
  const { records } = await captureDaemonLogs(async (records) => {
    const h = harness({
      respond: async () => {
        throw AgentTransportError.upstreamHttpResponse("task idle nudge", 503);
      },
    });
    h.nudge.maybeAsk("agent-a");
    await waitForEvent(records, "task_idle_nudge:failed");
  });
  const record = records.find((entry) => entry.properties.event === "task_idle_nudge:failed");
  expect(record?.properties.error_code).toBe("AgentTransportError");
  expect(record?.properties.failure_class).toBe("upstream_http_response");
  expect(record?.properties.upstream_status).toBe(503);
});

test("a failed delivery logs its message", async () => {
  const { records } = await captureDaemonLogs(async (records) => {
    const h = harness({
      deliver: async () => {
        throw new Error("session stdin closed");
      },
    });
    h.nudge.maybeAsk("agent-a");
    await waitForEvent(records, "task_idle_nudge:delivery_failed");
  });
  const record = records.find(
    (entry) => entry.properties.event === "task_idle_nudge:delivery_failed",
  );
  expect(record?.properties.error_message).toBe("session stdin closed");
});

test("a reminder with no writable session is logged as undelivered", async () => {
  const { records } = await captureDaemonLogs(async (records) => {
    const h = harness({ deliver: async () => false });
    h.nudge.maybeAsk("agent-a");
    await waitForEvent(records, "task_idle_nudge:delivery_failed");
  });
  const record = records.find(
    (entry) => entry.properties.event === "task_idle_nudge:delivery_failed",
  );
  expect(record?.properties.error_code).toBe("no_session");
});

test("a declined nudge logs the cloud's reason", async () => {
  const { records } = await captureDaemonLogs(async (records) => {
    const h = harness({ respond: async () => ({ send: false, reason: "stale" }) });
    h.nudge.maybeAsk("agent-a");
    await waitForEvent(records, "task_idle_nudge:skipped");
  });
  const record = records.find((entry) => entry.properties.event === "task_idle_nudge:skipped");
  expect(record?.properties.reason).toBe("stale");
});

test("a repeated decline for the same agent and reason is throttled to one line per ten minutes", async () => {
  const { records } = await captureDaemonLogs(async (records) => {
    const h = harness({ respond: async () => ({ send: false, reason: "stale" }) });
    h.nudge.maybeAsk("agent-a");
    await settle();
    h.nudge.maybeAsk("agent-a");
    await settle();
    h.advance(10 * 60 * 1000 + 1);
    h.nudge.maybeAsk("agent-a");
    await settle();
  });
  const skipped = records.filter((entry) => entry.properties.event === "task_idle_nudge:skipped");
  expect(skipped).toHaveLength(2);
});

test("a delivered reminder is logged so delivery can be verified end to end", async () => {
  const { records } = await captureDaemonLogs(async (records) => {
    const h = harness();
    h.nudge.maybeAsk("agent-a");
    await waitForEvent(records, "task_idle_nudge:delivered");
  });
  expect(records.some((entry) => entry.properties.event === "task_idle_nudge:delivered")).toBe(
    true,
  );
});

test("an unanswered ask logs its timeout", async () => {
  const { records } = await captureDaemonLogs(async (records) => {
    const h = harness({ respond: () => new Promise(() => {}), timeoutMs: 10 });
    h.nudge.maybeAsk("agent-a");
    await waitForEvent(records, "task_idle_nudge:timeout");
  });
  const record = records.find((entry) => entry.properties.event === "task_idle_nudge:timeout");
  expect(record?.properties.timeout_ms).toBe(10);
});
