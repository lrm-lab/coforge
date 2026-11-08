import { expect, test } from "bun:test";
import type { AgentRuntimeEvent, AgentSession, AgentSessionOptions } from "@lrm/coforge-anvil";
import type { CodeAgentProvider } from "@lrm/coforge-anvil";
import { TOOL_CALLS_LOGGED_PER_LAUNCH } from "#src/agent-runtime/tool-call-ledger";
import { activityHarness } from "./fixtures/activity-runtime";
import { captureDaemonLogs } from "./log-capture";

// A stall repair has to answer "was it running a build, or was it hung?" from the log alone: the
// tool calls it was in, and which one was still open (task #698).

const connection = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: `/tmp/coforge-tool-log-${crypto.randomUUID()}`,
};

/** One launch whose session hands the test direct control over its runtime events. */
async function toolLogHarness() {
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

test("a tool call writes its start and its end, with the Agent, the launch and no arguments", async () => {
  const { result, records } = await captureDaemonLogs(async () => {
    const harness = await toolLogHarness();
    try {
      harness.emitEvent({
        type: "tool-start",
        id: "call-1",
        name: "bash",
        input: { command: "npm run build" },
      });
      harness.emitEvent({ type: "tool-end", id: "call-1", isError: false, durationMs: 60_000 });
    } finally {
      await harness.runtime.stop();
    }
    return harness.launched;
  });
  const started = records.find(
    (record) => record.properties.event === "agent_runtime:tool_started",
  );
  const finished = records.find(
    (record) => record.properties.event === "agent_runtime:tool_finished",
  );
  expect(started?.level).toBe("info");
  expect(started?.properties).toMatchObject({
    agent_id: "agent-a",
    call_id: "call-1",
    tool: "bash",
  });
  expect(finished?.properties).toMatchObject({
    agent_id: "agent-a",
    call_id: "call-1",
    tool: "bash",
    duration_ms: 60_000,
    ok: true,
  });
  // The launch the runtime logs is the launch the provider's process was spawned under.
  const launchId = started?.properties.launch_id as string;
  expect(launchId).toBeString();
  expect(finished?.properties.launch_id).toBe(launchId);
  expect(result[0]?.environment?.COFORGE_AGENT_LAUNCH_ID).toBe(launchId);
  // Arguments and output are never logged: a command may quote a secret.
  expect(JSON.stringify(started?.properties)).not.toContain("npm run build");
});

test("the launch's tool log stops at its cap and says so once", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const harness = await toolLogHarness();
    try {
      for (let index = 0; index <= TOOL_CALLS_LOGGED_PER_LAUNCH; index += 1) {
        harness.emitEvent({ type: "tool-start", id: `call-${index}`, name: "read_file" });
        harness.emitEvent({ type: "tool-end", id: `call-${index}`, isError: false });
      }
    } finally {
      await harness.runtime.stop();
    }
  });
  const started = records.filter(
    (record) => record.properties.event === "agent_runtime:tool_started",
  );
  const truncated = records.filter(
    (record) => record.properties.event === "agent_runtime:tool_log_truncated",
  );
  expect(started).toHaveLength(TOOL_CALLS_LOGGED_PER_LAUNCH);
  expect(truncated).toHaveLength(1);
  expect(truncated[0]?.properties).toMatchObject({
    agent_id: "agent-a",
    logged: TOOL_CALLS_LOGGED_PER_LAUNCH,
  });
});

test("tool output is never logged", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const harness = await toolLogHarness();
    try {
      harness.emitEvent({ type: "tool-start", id: "call-1", name: "bash" });
      harness.emitEvent({ type: "tool-output", id: "call-1", text: "SECRET-OUTPUT" });
      harness.emitEvent({ type: "tool-end", id: "call-1", isError: true, exitCode: 2 });
      harness.emitEvent({ type: "tool-start", id: "call-2", name: "bash" });
      harness.emitEvent({ type: "tool-end", id: "call-2", isError: true });
    } finally {
      await harness.runtime.stop();
    }
  });
  const finished = records.filter(
    (record) => record.properties.event === "agent_runtime:tool_finished",
  );
  // A known exit code means the call ran: `ok` whatever the code, which is reported beside it.
  expect(finished[0]?.properties).toMatchObject({ exit_code: 2, ok: true });
  // A call with no exit code is judged by its error flag.
  expect(finished[1]?.properties).toMatchObject({ ok: false });
  expect(finished[1]?.properties).not.toHaveProperty("exit_code");
  expect(JSON.stringify(records.map((record) => record.properties))).not.toContain("SECRET-OUTPUT");
});

test("a repeated start for the same call writes one line and one cap slot", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const harness = await toolLogHarness();
    try {
      harness.emitEvent({ type: "tool-start", id: "call-1", name: "bash" });
      harness.emitEvent({ type: "tool-start", id: "call-1", name: "bash" });
      harness.emitEvent({ type: "tool-end", id: "call-1", isError: false });
    } finally {
      await harness.runtime.stop();
    }
  });
  const events = records
    .map((record) => record.properties.event)
    .filter((event) => String(event).startsWith("agent_runtime:tool_"));
  expect(events).toEqual(["agent_runtime:tool_started", "agent_runtime:tool_finished"]);
});

test("a call that never ends logs its start and no end", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const harness = await toolLogHarness();
    try {
      // A turn interrupted mid-command: the ledger keeps the call open and reports no outcome.
      harness.emitEvent({ type: "tool-start", id: "cmd-1", name: "bash" });
      harness.emitEvent({ type: "completed", status: "interrupted" });
    } finally {
      await harness.runtime.stop();
    }
  });
  const events = records
    .map((record) => record.properties.event)
    .filter((event) => String(event).startsWith("agent_runtime:tool_"));
  expect(events).toEqual(["agent_runtime:tool_started"]);
});
