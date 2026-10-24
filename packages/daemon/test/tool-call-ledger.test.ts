import { expect, test } from "bun:test";
import { TOOL_CALL_LEDGER_MAX, ToolCallLedger } from "#src/agent-runtime/tool-call-ledger";

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
