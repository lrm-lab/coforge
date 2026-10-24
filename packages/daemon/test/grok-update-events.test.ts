import { expect, test } from "bun:test";
import { GrokTurnEvents } from "#src/code-agent/grok/update-events";

function finishedShell(rawOutput: Record<string, unknown>, status = "completed") {
  const turn = new GrokTurnEvents();
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

test("real Grok ACP delta frames emit an early intent only after the target is closed", async () => {
  const turn = new GrokTurnEvents();
  const frames = (
    await Bun.file(new URL("./fixtures/grok-reply-intent.jsonl", import.meta.url)).text()
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { params: { update: Record<string, unknown> } });
  expect(turn.read(frames[0]!.params.update)).toEqual([]);
  expect(turn.read(frames[1]!.params.update)).toEqual([
    { type: "reply-intent", id: "call-fixture-0", target: "@bob" },
  ]);
  expect(turn.read(frames[2]!.params.update)).toEqual([
    {
      type: "tool-start",
      id: "call-fixture-0",
      name: "run_terminal_command",
      input: { command: "coforge message send --target @bob --body hello" },
    },
  ]);
});

test("scans a target split across Grok argument deltas", () => {
  const turn = new GrokTurnEvents();
  expect(
    turn.read({
      sessionUpdate: "tool_call_delta_chunk",
      tool_call_id: "split",
      tool_index: 0,
      name: "run_terminal_command",
    }),
  ).toEqual([]);
  expect(
    turn.read({
      sessionUpdate: "tool_call_delta_chunk",
      tool_index: 0,
      arguments_delta: '{"command":"coforge message send --target @bo',
    }),
  ).toEqual([]);
  expect(
    turn.read({
      sessionUpdate: "tool_call_delta_chunk",
      tool_index: 0,
      arguments_delta: 'b --body hello"}',
    }),
  ).toEqual([{ type: "reply-intent", id: "split", target: "@bob" }]);
});

test("does not scan arguments from a non-shell Grok tool", () => {
  const turn = new GrokTurnEvents();
  expect(
    turn.read({
      sessionUpdate: "tool_call_delta_chunk",
      tool_call_id: "write",
      tool_index: 0,
      name: "write_file",
    }),
  ).toEqual([]);
  expect(
    turn.read({
      sessionUpdate: "tool_call_delta_chunk",
      tool_index: 0,
      arguments_delta: '{"command":"coforge message send --target @bob"}',
    }),
  ).toEqual([]);
});
