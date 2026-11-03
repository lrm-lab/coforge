import { expect, test } from "bun:test";
import {
  TaskIdleNudge,
  type TaskIdleNudgePorts,
  type IdleNudgeRequest,
  type IdleNudgeResponse,
} from "#src/daemon-runtime/task-idle-nudge";

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

test("a server without the route is not asked again", async () => {
  const h = harness({ respond: async () => undefined });
  h.nudge.maybeAsk("agent-a");
  await settle();
  h.nudge.maybeAsk("agent-b");
  await settle();
  expect(h.asks).toHaveLength(1);
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
