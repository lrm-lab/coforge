import { expect, test } from "bun:test";
import type { AgentRuntimeEvent, AgentSession, AgentSessionOptions } from "@lrm/coforge-anvil";
import type { CodeAgentProvider } from "@lrm/coforge-anvil";
import type { LogRecord } from "@logtape/logtape";
import {
  TOOL_CALLS_LOGGED_PER_LAUNCH,
  TOOL_CALL_LOG_MIN_MS,
  ToolCallLedger,
} from "#src/agent-runtime/tool-call-ledger";
import { activityHarness } from "./fixtures/activity-runtime";
import { captureDaemonLogs } from "./log-capture";

// A stall repair has to answer "was it running a build, or was it hung?" from the log alone: the
// tool calls that ran long enough to still be running when the turn went quiet (task #698).

const connection = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: `/tmp/coforge-tool-log-${crypto.randomUUID()}`,
};

/** A ledger whose clocks the test sets, logging under a known Agent and launch. */
function ledgerOnAClock() {
  let now = 0;
  const calls = new ToolCallLedger(
    () => now,
    () => now,
    () => now,
    { identity: { agentId: "agent-a", launchId: "launch-a" } },
  );
  return { calls, at: (ms: number) => void (now = ms) };
}

function toolEvents(records: readonly LogRecord[]) {
  return records
    .filter((record) => String(record.properties.event).startsWith("agent_runtime:tool_"))
    .map((record) => record.properties);
}

test("a call that ran five seconds or more is one line, with no arguments and no output", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const { calls, at } = ledgerOnAClock();
    calls.observe({
      type: "tool-start",
      id: "call-1",
      name: "bash",
      input: { cmd: "npm run build" },
    });
    at(60_200);
    const end = { type: "tool-end", id: "call-1", isError: false } as const;
    calls.observe(end);
    calls.finish(end);
  });
  const [line] = toolEvents(records);
  expect(line).toMatchObject({
    event: "agent_runtime:tool_finished",
    agent_id: "agent-a",
    launch_id: "launch-a",
    call_id: "call-1",
    tool: "bash",
    duration_ms: 60_200,
    ok: true,
  });
  // Arguments and output are never logged: a command may quote a secret.
  expect(JSON.stringify(line)).not.toContain("npm run build");
});

test("a call that ends inside five seconds writes nothing", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const { calls, at } = ledgerOnAClock();
    // The measured medians: half of all calls end inside 0.2 s, 89% inside five seconds.
    for (const [index, duration] of [200, TOOL_CALL_LOG_MIN_MS - 1].entries()) {
      at(index * 100_000);
      calls.observe({ type: "tool-start", id: `call-${index}`, name: "read_file" });
      at(index * 100_000 + duration);
      const end = { type: "tool-end", id: `call-${index}`, isError: true } as const;
      calls.observe(end);
      calls.finish(end);
    }
  });
  expect(toolEvents(records)).toEqual([]);
});

test("a call still open and below the threshold at the turn's end writes nothing", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const { calls, at } = ledgerOnAClock();
    calls.observe({ type: "tool-start", id: "call-1", name: "read_file" });
    at(TOOL_CALL_LOG_MIN_MS - 1);
    calls.observe({ type: "completed", status: "interrupted" });
  });
  expect(toolEvents(records)).toEqual([]);
});

test("a call still open when its turn completes is one line saying it never reported an end", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const { calls, at } = ledgerOnAClock();
    // A turn interrupted mid-command: the ledger keeps the call open and reports no outcome.
    calls.observe({ type: "tool-start", id: "cmd-1", name: "bash" });
    at(20_000);
    calls.observe({ type: "completed", status: "interrupted" });
  });
  const [line] = toolEvents(records);
  expect(line).toMatchObject({
    event: "agent_runtime:tool_unfinished",
    agent_id: "agent-a",
    call_id: "cmd-1",
    tool: "bash",
    duration_ms: 20_000,
  });
  // No outcome was published, so the line claims none.
  expect(line).not.toHaveProperty("ok");
  expect(line).not.toHaveProperty("exit_code");
});

test("the gate is the ledger's own window, not the provider's duration", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const { calls, at } = ledgerOnAClock();
    // A provider that measured only the tool's own execution: its second understates the nine
    // minutes the turn was silent, which is the silence this line exists to explain.
    calls.observe({ type: "tool-start", id: "call-1", name: "bash" });
    at(9 * 60_000);
    const end = {
      type: "tool-end",
      id: "call-1",
      isError: false,
      durationMs: 2_000,
    } as const;
    calls.observe(end);
    calls.finish(end);
    // And the reverse: a provider claiming a minute for a call the ledger saw end at once.
    calls.observe({ type: "tool-start", id: "call-2", name: "read_file" });
    at(9 * 60_000 + 500);
    const quick = {
      type: "tool-end",
      id: "call-2",
      isError: false,
      durationMs: 60_000,
    } as const;
    calls.observe(quick);
    calls.finish(quick);
  });
  const lines = toolEvents(records);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ call_id: "call-1", duration_ms: 540_000 });
});

test("a call whose end was observed but never finished is written once, by the turn's end", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const { calls, at } = ledgerOnAClock();
    // The runtime can drop an event before `finish()` runs (a non-current launch, a disposed
    // trajectory, a reconciled idle turn); the ledger still saw this call start and end.
    calls.observe({ type: "tool-start", id: "call-1", name: "bash" });
    at(30_000);
    calls.observe({ type: "tool-end", id: "call-1", isError: false });
    calls.observe({ type: "completed", status: "completed" });
  });
  const lines = toolEvents(records);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    event: "agent_runtime:tool_finished",
    call_id: "call-1",
    duration_ms: 30_000,
  });
  // No outcome was published, so the line claims none.
  expect(lines[0]).not.toHaveProperty("ok");
});

test("a launch that ends still holding a call writes its line", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const { calls, at } = ledgerOnAClock();
    // The turn-scoped kill and a shutdown both end the process with the call in flight: no
    // `tool-end` and no `completed` ever arrive.
    calls.observe({ type: "tool-start", id: "call-1", name: "bash" });
    at(15 * 60_000);
    calls.logAbandoned();
  });
  const lines = toolEvents(records);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    event: "agent_runtime:tool_unfinished",
    call_id: "call-1",
    tool: "bash",
    duration_ms: 900_000,
  });
  expect(lines[0]).not.toHaveProperty("ok");
});

test("a repeated start re-opens the call and re-times it, as it did before anything was logged", () => {
  const { calls, at } = ledgerOnAClock();
  calls.observe({ type: "tool-start", id: "call-1", name: "bash" });
  at(1_000);
  const end = { type: "tool-end", id: "call-1", isError: false } as const;
  calls.observe(end);
  expect(calls.hasOpenToolCall).toBe(false);
  calls.finish(end);
  // A provider that replays the start is asking about that call again: it is open, and the
  // silence clock runs from the replay, not from the first start.
  at(50_000);
  calls.observe({ type: "tool-start", id: "call-1", name: "bash" });
  expect(calls.hasOpenToolCall).toBe(true);
  expect(calls.oldestOpenTool()).toEqual({ name: "bash", silentForMs: 0 });
  at(53_000);
  expect(calls.oldestOpenTool()).toEqual({ name: "bash", silentForMs: 3_000 });
});

test("a repeated start writes one line for the call, from the window it ended with", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const { calls, at } = ledgerOnAClock();
    calls.observe({ type: "tool-start", id: "call-1", name: "bash" });
    at(20_000);
    // The replay re-times the call, so the first 20 s are not part of the window it reports.
    calls.observe({ type: "tool-start", id: "call-1", name: "bash" });
    at(26_000);
    const end = { type: "tool-end", id: "call-1", isError: false } as const;
    calls.observe(end);
    calls.finish(end);
  });
  const lines = toolEvents(records);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ call_id: "call-1", duration_ms: 6_000 });
});

test("an end for a call the ledger never tracked writes nothing: it has no name to report", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const { calls, at } = ledgerOnAClock();
    // Dropped for room, or a session attached mid-call: its start was never seen, so neither the
    // tool's name nor a window from that start exists.
    at(600_000);
    calls.finish({ type: "tool-end", id: "unknown-1", isError: false, durationMs: 600_000 });
  });
  expect(toolEvents(records)).toEqual([]);
});

test("the launch's tool log stops at its cap and says so once", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const { calls, at } = ledgerOnAClock();
    for (let index = 0; index <= TOOL_CALLS_LOGGED_PER_LAUNCH; index += 1) {
      calls.observe({ type: "tool-start", id: `call-${index}`, name: "read_file" });
      at(index * 10_000 + 10_000);
      const end = { type: "tool-end", id: `call-${index}`, isError: false } as const;
      calls.observe(end);
      calls.finish(end);
    }
  });
  const logged = toolEvents(records).filter(
    (properties) => properties.event === "agent_runtime:tool_finished",
  );
  const truncated = toolEvents(records).filter(
    (properties) => properties.event === "agent_runtime:tool_log_truncated",
  );
  expect(logged).toHaveLength(TOOL_CALLS_LOGGED_PER_LAUNCH);
  expect(truncated).toHaveLength(1);
  expect(truncated[0]).toMatchObject({ agent_id: "agent-a", logged: TOOL_CALLS_LOGGED_PER_LAUNCH });
});

test("calls below the threshold cost no cap slot", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const { calls, at } = ledgerOnAClock();
    // Many quick calls, then a slow one: the slow one is logged, so the quick ones spent nothing.
    for (let index = 0; index < TOOL_CALLS_LOGGED_PER_LAUNCH * 2; index += 1) {
      calls.observe({ type: "tool-start", id: `quick-${index}`, name: "read_file" });
      at(index * 1_000 + 10);
      const end = { type: "tool-end", id: `quick-${index}`, isError: false } as const;
      calls.observe(end);
      calls.finish(end);
    }
    calls.observe({ type: "tool-start", id: "slow", name: "bash" });
    at(TOOL_CALLS_LOGGED_PER_LAUNCH * 2 * 1_000 + 60_000);
    const slow = { type: "tool-end", id: "slow", isError: false } as const;
    calls.observe(slow);
    calls.finish(slow);
  });
  expect(toolEvents(records)).toHaveLength(1);
  expect(toolEvents(records)[0]).toMatchObject({ call_id: "slow" });
});

test("a call of exactly the threshold is logged", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const { calls, at } = ledgerOnAClock();
    calls.observe({ type: "tool-start", id: "call-1", name: "bash" });
    at(TOOL_CALL_LOG_MIN_MS);
    const end = { type: "tool-end", id: "call-1", isError: false } as const;
    calls.observe(end);
    calls.finish(end);
  });
  expect(toolEvents(records)[0]).toMatchObject({ duration_ms: TOOL_CALL_LOG_MIN_MS });
});

test("the line the daemon writes names the launch its provider process was spawned under", async () => {
  const { result, records } = await captureDaemonLogs(async () => {
    const harness = await launchWithControlledEvents();
    try {
      harness.emitEvent({ type: "tool-start", id: "call-1", name: "bash" });
      harness.emitEvent({ type: "tool-output", id: "call-1", text: "SECRET-OUTPUT" });
      // The ledger times a call on the real clock here, so the call has to last the threshold.
      await Bun.sleep(TOOL_CALL_LOG_MIN_MS + 100);
      harness.emitEvent({ type: "tool-end", id: "call-1", isError: true, exitCode: 2 });
    } finally {
      await harness.runtime.stop();
    }
    return harness.launched;
  });
  const [line] = toolEvents(records);
  const launchId = line?.launch_id as string;
  expect(line).toMatchObject({
    event: "agent_runtime:tool_finished",
    agent_id: "agent-a",
    call_id: "call-1",
    exit_code: 2,
    ok: true,
  });
  expect(launchId).toBeString();
  expect(result[0]?.environment?.COFORGE_AGENT_LAUNCH_ID).toBe(launchId);
  // Neither the tool's arguments nor its output may reach the log: a command may quote a secret.
  expect(JSON.stringify(records.map((record) => record.properties))).not.toContain("SECRET-OUTPUT");
}, 20_000);

/** One launch whose session hands the test direct control over its runtime events. */
async function launchWithControlledEvents() {
  const launched: AgentSessionOptions[] = [];
  let listener: (event: AgentRuntimeEvent) => void = () => undefined;
  const provider: CodeAgentProvider = {
    provider: "pi",
    async createAgentSession(options) {
      launched.push(options);
      const session: AgentSession = {
        async sendMessage() {},
        subscribe(next) {
          listener = next;
          return () => undefined;
        },
        async interrupt() {},
        onExit() {
          return () => undefined;
        },
        async dispose() {},
      };
      return session;
    },
  };
  const harness = await activityHarness(connection, provider);
  return { ...harness, launched, emitEvent: (event: AgentRuntimeEvent) => listener(event) };
}
