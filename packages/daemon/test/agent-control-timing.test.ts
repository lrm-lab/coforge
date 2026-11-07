import { expect, test } from "bun:test";
import { AgentControlOpTiming } from "#src/agent-runtime/agent-control-timing";
import { captureDaemonLogs } from "./log-capture";

const phases = (records: { properties: Record<string, unknown> }[]) =>
  records
    .filter((entry) => entry.properties.event === "agent_control:phase")
    .map((entry) => entry.properties);

test("an operation logs received then result_sent under one request id", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const timing = new AgentControlOpTiming("daemon-1");
    timing.received("stop", "agent-1", "req-1");
    timing.resultSent({ agentId: "agent-1", requestId: "req-1", phase: "stopped" });
  });
  expect(phases(records)).toEqual([
    expect.objectContaining({
      agent_id: "agent-1",
      request_id: "req-1",
      op: "stop",
      phase: "received",
      daemon_instance_id: "daemon-1",
    }),
    expect.objectContaining({
      agent_id: "agent-1",
      request_id: "req-1",
      op: "stop",
      phase: "result_sent",
      result_phase: "stopped",
    }),
  ]);
  const [received, sent] = phases(records);
  if (!received || !sent) throw new Error("expected received and result_sent phases");
  expect(typeof received.elapsed_ms).toBe("number");
  expect(typeof received.since_previous_ms).toBe("number");
  expect(sent.elapsed_ms as number).toBeGreaterThanOrEqual(received.elapsed_ms as number);
});

test("a result for a request this runtime never saw is not timed", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const timing = new AgentControlOpTiming("daemon-1");
    timing.resultSent({ agentId: "agent-1", requestId: "old-req", phase: "stopped" });
  });
  expect(phases(records)).toEqual([]);
});

test("a repeated receive for the same request keeps one clock; a new request replaces it", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const timing = new AgentControlOpTiming("daemon-1");
    timing.received("start", "agent-1", "req-1");
    timing.received("start", "agent-1", "req-1");
    timing.received("start", "agent-1", "req-2");
    timing.resultSent({ agentId: "agent-1", requestId: "req-1", phase: "started" });
    timing.resultSent({ agentId: "agent-1", requestId: "req-2", phase: "started" });
  });
  const logged = phases(records);
  expect(logged.filter((p) => p.phase === "received")).toHaveLength(2);
  expect(logged.filter((p) => p.request_id === "req-1")).toHaveLength(1);
  expect(logged.filter((p) => p.phase === "result_sent" && p.request_id === "req-2")).toHaveLength(
    1,
  );
});
