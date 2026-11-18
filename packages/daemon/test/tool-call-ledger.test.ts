import { expect, test } from "bun:test";
import { countLiveProcessDescendants } from "#src/agent-runtime/process-descendants";
import { TOOL_CALL_LEDGER_MAX, ToolCallLedger } from "#src/agent-runtime/tool-call-ledger";
import { captureDaemonLogs } from "./log-capture";

/** A ledger on a clock the test sets. */
function ledger() {
  let now = 0;
  const calls = new ToolCallLedger(() => now);
  return {
    calls,
    at(ms: number) {
      now = ms;
    },
  };
}

test("tracks open tool calls by id, and a completed turn closes every one", () => {
  const { calls } = ledger();
  calls.observe({ type: "tool-start", id: "tool-1", name: "bash" });
  calls.observe({ type: "tool-start", id: "tool-2", name: "bash" });
  expect(calls.hasOpenToolCall).toBe(true);
  calls.observe({ type: "tool-end", id: "tool-1", isError: false });
  expect(calls.hasOpenToolCall).toBe(true);
  calls.observe({ type: "tool-end", id: "tool-2", isError: false });
  expect(calls.hasOpenToolCall).toBe(false);
  calls.observe({ type: "tool-start", id: "tool-3", name: "bash" });
  calls.observe({ type: "completed", status: "interrupted" });
  expect(calls.hasOpenToolCall).toBe(false);
});

test("times a call from its start to its end on the ledger's monotonic clock", () => {
  const { calls, at } = ledger();
  at(100);
  calls.observe({ type: "tool-start", id: "call-1", name: "bash" });
  at(1_600.4);
  const end = { type: "tool-end", id: "call-1", isError: false } as const;
  calls.observe(end);
  at(9_000);
  expect(calls.finish(end)).toEqual({ callId: "call-1", ok: true, durationMs: 1_500 });
  // Reported once: the same end again has no start to time it from.
  expect(calls.finish(end)).toEqual({ callId: "call-1", ok: true });
});

test("a completed turn forgets its calls: a late end reports no duration", () => {
  const { calls, at } = ledger();
  calls.observe({ type: "tool-start", id: "call-1", name: "bash" });
  calls.observe({ type: "completed", status: "interrupted" });
  at(500);
  const end = { type: "tool-end", id: "call-1", isError: true } as const;
  calls.observe(end);
  expect(calls.finish(end)).toEqual({ callId: "call-1", ok: false });
});

test("a known exit code makes the call ok whatever its value; an out-of-range one is dropped", () => {
  const { calls } = ledger();
  expect(calls.finish({ type: "tool-end", id: "a", isError: true, exitCode: 2 })).toEqual({
    callId: "a",
    ok: true,
    exitCode: 2,
  });
  expect(calls.finish({ type: "tool-end", id: "b", isError: true, exitCode: 2 ** 31 })).toEqual({
    callId: "b",
    ok: false,
  });
});

test("a provider's duration wins; an id that cannot go on the wire reports nothing", () => {
  const { calls, at } = ledger();
  calls.observe({ type: "tool-start", id: "call-1", name: "read" });
  at(5_000);
  expect(
    calls.finish({ type: "tool-end", id: "call-1", isError: false, durationMs: 42.4 }),
  ).toEqual({ callId: "call-1", ok: true, durationMs: 42 });
  expect(calls.finish({ type: "tool-end", id: "", isError: false })).toBeUndefined();
  expect(calls.finish({ type: "tool-end", id: "a".repeat(129), isError: false })).toBeUndefined();
});

test("reports the oldest open tool by name and elapsed monotonic time", () => {
  const { calls, at } = ledger();
  at(100);
  calls.observe({ type: "tool-start", id: "call-1", name: "read" });
  at(250);
  calls.observe({ type: "tool-start", id: "call-2", name: "bash" });
  at(1_100);
  expect(calls.oldestOpenTool()).toEqual({ name: "read", silentForMs: 1_000 });
  calls.observe({ type: "tool-end", id: "call-1", isError: false });
  expect(calls.oldestOpenTool()).toEqual({ name: "bash", silentForMs: 850 });
});

test("bounds tracked open tools", () => {
  const ledger = new ToolCallLedger(
    () => 1,
    () => 1,
  );
  for (let i = 0; i < TOOL_CALL_LEDGER_MAX + 1; i++)
    ledger.observe({ type: "tool-start", id: `tool-${i}`, name: "Bash", input: {} });
  expect(ledger.oldestOpenTool()?.name).toBe("Bash");
});

test("openToolHoldsNoLiveWork returns false without per-tool exit proof (no_evidence or alive_silent_blocked)", async () => {
  let now = 100;
  const statuses = new Map<string, boolean | undefined>();
  const calls = new ToolCallLedger(
    () => now,
    () => now,
    () => 5_000,
    {
      identity: { agentId: "agent-a", launchId: "launch-1" },
      isToolProcessAlive: async (callId) => statuses.get(callId),
    },
  );
  expect(await calls.openToolHoldsNoLiveWork()).toBe(false);
  calls.observe({ type: "tool-start", id: "call-1", name: "bash" });
  calls.observe({ type: "tool-start", id: "call-mcp", name: "mcp_fetch" });
  now = 900_100;

  statuses.set("call-1", true);
  statuses.set("call-mcp", undefined);
  expect(await calls.openToolHoldsNoLiveWork()).toBe(false);

  statuses.set("call-1", false);
  statuses.set("call-mcp", undefined);
  expect(await calls.openToolHoldsNoLiveWork()).toBe(false);

  statuses.set("call-mcp", false);
  const { records } = await captureDaemonLogs(async () => {
    expect(await calls.openToolHoldsNoLiveWork()).toBe(true);
    expect(await calls.openToolHoldsNoLiveWork()).toBe(true);
  });
  const logged = records.filter(
    (entry) => entry.properties.event === "agent_runtime:tool_completion_loss",
  );
  expect(logged).toHaveLength(2);
  expect(logged[0]?.properties).toMatchObject({
    agent_id: "agent-a",
    launch_id: "launch-1",
    call_id: "call-1",
    tool: "bash",
    silent_for_ms: 900_000,
  });
});

test("countLiveProcessDescendants walks the process tree and fences by processClockMs resolution", async () => {
  const table = {
    resolutionMs: 1_000,
    async list() {
      return [
        { pid: 100, ppid: 1, pgid: 100, startedAtMs: 1_000 },
        // Session-level helper started before the tool call.
        { pid: 101, ppid: 100, pgid: 100, startedAtMs: 2_000 },
        // Tool child and grandchild started inside the tool window.
        { pid: 200, ppid: 100, pgid: 200, startedAtMs: 10_000 },
        { pid: 201, ppid: 200, pgid: 200, startedAtMs: 11_000 },
      ];
    },
  };
  expect(await countLiveProcessDescendants(undefined, { processTable: table })).toBeUndefined();
  expect(await countLiveProcessDescendants(999, { processTable: table })).toBeUndefined();
  expect(await countLiveProcessDescendants(100, { processTable: table })).toBe(3);
  expect(
    await countLiveProcessDescendants(100, { processTable: table, startedAfterMs: 10_500 }),
  ).toBe(2);
  expect(
    await countLiveProcessDescendants(100, { processTable: table, startedAfterMs: 20_000 }),
  ).toBe(0);
});
