import { describe, expect, test } from "bun:test";
import { CodexSubagentThreads } from "@lrm/coforge-anvil/codex";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";

const timestamp = "2026-11-06T10:00:00.000Z";
const note = (method: string, threadId: string, params: Record<string, unknown> = {}) => ({
  method,
  timestamp,
  params: { threadId, ...params },
});

/** A completed spawn call on the main thread naming one receiver thread. */
function spawn(itemId: string, threadId: string) {
  return {
    item: {
      type: "collabAgentToolCall",
      id: itemId,
      tool: "spawnAgent",
      receiverThreadIds: [threadId],
      agentsStates: { [threadId]: { status: "running" } },
    },
    spawnCallId: itemId,
  };
}

function progress(events: AgentRuntimeEvent[]) {
  return events.flatMap((event) =>
    event.type === "subagent-progress"
      ? [{ phase: event.phase, taskId: event.taskId, status: event.taskStatus }]
      : [],
  );
}

describe("CodexSubagentThreads", () => {
  test("a spawn call registers its receiver and its turn lifecycle reports progress", () => {
    const threads = new CodexSubagentThreads("main");
    const { item, spawnCallId } = spawn("call-1", "sub-1");
    const started = threads.noteCollabAgentStates(item, spawnCallId, timestamp);
    expect(progress(started)).toEqual([{ phase: "started", taskId: "sub-1", status: undefined }]);

    const turnStart = threads.acceptSecondary(
      note("turn/started", "sub-1", { turn: { id: "turn-9" } }),
      "sub-1",
    );
    expect(turnStart).toEqual([]);
    expect(threads.runningSubagentTurn("sub-1")).toEqual({
      threadId: "sub-1",
      turnId: "turn-9",
    });

    const ended = threads.acceptSecondary(
      note("turn/completed", "sub-1", { turn: { id: "turn-9", status: "completed" } }),
      "sub-1",
    );
    expect(progress(ended)).toEqual([
      { phase: "notification", taskId: "sub-1", status: "completed" },
    ]);
    expect(threads.runningSubagentTurn("sub-1")).toBeUndefined();
  });

  test("a thread that ended before its spawn call registered does not report a start", () => {
    const threads = new CodexSubagentThreads("main");
    threads.acceptSecondary(
      note("turn/completed", "sub-2", { turn: { status: "completed" } }),
      "sub-2",
    );
    const { item, spawnCallId } = spawn("call-2", "sub-2");
    item.agentsStates = { "sub-2": { status: "completed" } };
    expect(threads.noteCollabAgentStates(item, spawnCallId, timestamp)).toEqual([]);
  });

  test("subagent items carry the spawn call as their lineage", () => {
    const threads = new CodexSubagentThreads("main");
    const { item, spawnCallId } = spawn("call-3", "sub-3");
    threads.noteCollabAgentStates(item, spawnCallId, timestamp);
    const events = threads.acceptSecondary(
      note("item/completed", "sub-3", {
        item: { type: "agentMessage", id: "m1", text: "done" },
      }),
      "sub-3",
    );
    expect(events).toEqual([
      { type: "text-delta", text: "done", subagent: { parentToolUseId: "call-3" } },
    ]);
  });

  test("a collab state's terminal status ends a running subagent", () => {
    const threads = new CodexSubagentThreads("main");
    const { item, spawnCallId } = spawn("call-4", "sub-4");
    threads.noteCollabAgentStates(item, spawnCallId, timestamp);
    threads.acceptSecondary(note("turn/started", "sub-4", { turn: { id: "t1" } }), "sub-4");
    const events = threads.noteCollabAgentStates(
      {
        type: "collabAgentToolCall",
        id: "call-4b",
        tool: "wait",
        agentsStates: { "sub-4": { status: "interrupted" } },
      },
      "call-4b",
      timestamp,
    );
    expect(progress(events)).toEqual([
      { phase: "notification", taskId: "sub-4", status: "stopped" },
    ]);
  });
});
