import { expect, test } from "bun:test";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { AntigravityAcpTurnEvents } from "@lrm/coforge-anvil/antigravity";

const host = {
  isShellToolName: (name: string) => name === "run_command",
  createReplyIntentScanner: () => ({
    feed: () => undefined,
    complete: () => {},
    reset: () => [],
  }),
};

const echoInput = { CommandLine: "echo n1", WaitMsBeforeAsync: 5000, toolSummary: "Echo n1" };
const echoOutput = [
  {
    type: "content",
    content: { type: "text", text: "Command exited with code 0.\n\nCommand output:\nn1\r\n" },
  },
];

const liveCall = [
  {
    sessionUpdate: "tool_call",
    status: "in_progress",
    toolCallId: "call_live",
    name: "run_command",
    title: "echo n1",
    kind: "execute",
    rawInput: echoInput,
    content: null,
  },
  {
    sessionUpdate: "tool_call_update",
    status: "pending",
    toolCallId: "call_live",
    name: "run_command",
    title: "echo n1",
    kind: "execute",
    rawInput: echoInput,
    content: null,
  },
  {
    sessionUpdate: "tool_call_update",
    status: "completed",
    toolCallId: "call_live",
    name: "run_command",
    title: "echo n1",
    kind: "execute",
    rawInput: echoInput,
    content: echoOutput,
  },
];

const finishedCall = (id: string, status = "completed") => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  name: "run_command",
  args: echoInput,
  status,
  kind: "execute",
  title: "echo n1",
  rawInput: echoInput,
  rawOutput: { output: "n1\r\n", exit_code: 0 },
  content: echoOutput,
});

function read(updates: Record<string, unknown>[]): AgentRuntimeEvent[] {
  const turn = new AntigravityAcpTurnEvents(host as never);
  return updates.flatMap((update) => turn.read(update));
}

function openCalls(events: AgentRuntimeEvent[]): string[] {
  const open = new Set<string>();
  for (const event of events) {
    if (event.type === "tool-start") open.add(event.id);
    if (event.type === "tool-end") open.delete(event.id);
  }
  return [...open];
}

test("a live agy call starts in progress and ends on its completed update", () => {
  const events = read(liveCall);
  expect(events.map((event) => event.type)).toEqual([
    "tool-start",
    "progress",
    "tool-output",
    "tool-end",
  ]);
  expect(openCalls(events)).toEqual([]);
});

test("a tool_call that arrives already completed is recorded as a call that started and ended", () => {
  const events = read([finishedCall("call_replayed")]);
  expect(events.map((event) => event.type)).toEqual(["tool-start", "tool-output", "tool-end"]);
  expect(events.at(-1)).toEqual({ type: "tool-end", id: "call_replayed", isError: false });
});

test("a completed tool_call mid-turn neither stays open nor is dropped", () => {
  const events = read([
    ...liveCall.slice(0, 2),
    finishedCall("call_fast"),
    finishedCall("call_failed", "failed"),
    liveCall[2]!,
  ]);
  const started = events.filter((event) => event.type === "tool-start").map((event) => event.id);
  expect(started).toEqual(["call_live", "call_fast", "call_failed"]);
  expect(openCalls(events)).toEqual([]);
  expect(events).toContainEqual({ type: "tool-end", id: "call_failed", isError: true });
});

test("an update for a call that arrived already ended adds nothing", () => {
  const events = read([
    finishedCall("call_replayed"),
    { ...liveCall[2]!, toolCallId: "call_replayed" },
  ]);
  expect(events.filter((event) => event.type === "tool-end")).toHaveLength(1);
});
