import { expect, test } from "bun:test";
import type { AgentTurnInterruptIntent } from "@lrm/coforge-sdk/internal";
import { interruptAgentTurn, type TurnInterruptHost } from "#src/daemon-runtime/turn-interrupt";
import { SubagentWakeTracker } from "#src/agent-runtime/subagent-progress-activity";

const intent: AgentTurnInterruptIntent = {
  protocolMajor: 1,
  requestId: "req-1",
  workspaceId: "ws-1",
  computerId: "pc-1",
  agentId: "agent-1",
  provider: "codex",
  epoch: 1,
  launchId: "launch-1",
};

function host(
  overrides: Partial<
    TurnInterruptHost<{
      launchId: string;
      subagentWake?: SubagentWakeTracker;
    }>
  > = {},
) {
  const reported: { status: string; subagentTaskId?: string }[] = [];
  const h: TurnInterruptHost<{ launchId: string; subagentWake?: SubagentWakeTracker }> = {
    launch: () => ({ launchId: "launch-1" }),
    interrupt: async () => "interrupted",
    publish: () => {},
    report: async (result) => {
      reported.push({ status: result.status, subagentTaskId: result.subagentTaskId });
    },
    ...overrides,
  };
  return { h, reported };
}

test("a subagent stop reports the session's answer and touches no turn state", async () => {
  const subagentWake = new SubagentWakeTracker();
  const { h, reported } = host({
    launch: () => ({ launchId: "launch-1", subagentWake }),
    interruptSubagent: async (agentId, taskId) => {
      expect(agentId).toBe("agent-1");
      expect(taskId).toBe("task-9");
      return "interrupted";
    },
    interrupt: async () => {
      throw new Error("the whole turn must not be interrupted");
    },
  });
  await interruptAgentTurn(h, { ...intent, subagentTaskId: "task-9" });
  expect(reported).toEqual([{ status: "interrupted", subagentTaskId: "task-9" }]);
  // The user's stop is remembered: the task's own ending reads as stopped_by_user.
  expect(subagentWake.noteTerminal("task-9", "stopped")).toBe(true);
  expect(subagentWake.resultUnread).toBe(false);
});

test("a subagent stop on a stale launch or missing port reports without side effects", async () => {
  const stale = host({ launch: () => undefined });
  await interruptAgentTurn(stale.h, { ...intent, subagentTaskId: "task-9" });
  expect(stale.reported).toEqual([{ status: "not_running", subagentTaskId: "task-9" }]);

  const unsupported = host();
  await interruptAgentTurn(unsupported.h, { ...intent, subagentTaskId: "task-9" });
  expect(unsupported.reported).toEqual([{ status: "unsupported", subagentTaskId: "task-9" }]);
});
