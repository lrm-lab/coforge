import { fixtureGrokHost } from "./fixtures/grok-host";
import { expect, test } from "bun:test";
import { GrokTurnEvents } from "#src/grok/update-events";

function finishedShell(rawOutput: Record<string, unknown>, status = "completed") {
  const turn = new GrokTurnEvents(fixtureGrokHost);
  turn.read({ sessionUpdate: "tool_call", toolCallId: "tool-1", rawInput: { command: "make" } });
  return turn.read({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", status, rawOutput });
}

test("a finished Grok shell call reports its rawOutput exit code", () => {
  expect(finishedShell({ type: "Bash", exit_code: 2, timed_out: false })).toEqual([
    { type: "tool-end", id: "tool-1", isError: true, exitCode: 2 },
  ]);
  expect(finishedShell({ type: "Bash", exit_code: 0, timed_out: false })).toEqual([
    { type: "tool-end", id: "tool-1", isError: false, exitCode: 0 },
  ]);
});

test("a Grok call with no integer exit code reports none", () => {
  expect(finishedShell({ type: "ReadFile" })).toEqual([
    { type: "tool-end", id: "tool-1", isError: false },
  ]);
  expect(finishedShell({ type: "Bash", exit_code: "2" })).toEqual([
    { type: "tool-end", id: "tool-1", isError: false },
  ]);
});

test("Grok usage_update emits context-usage for valid readings and ignores malformed ones", () => {
  const turn = new GrokTurnEvents(fixtureGrokHost);
  expect(turn.read({ sessionUpdate: "usage_update", used: 185_000, size: 256_000 })).toEqual([
    { type: "context-usage", usedTokens: 185_000, windowTokens: 256_000 },
  ]);
  expect(turn.read({ sessionUpdate: "usage_update", used: -1, size: 256_000 })).toEqual([]);
  expect(turn.read({ sessionUpdate: "usage_update", used: 100, size: 0 })).toEqual([]);
});
