import { expect, test } from "bun:test";
import { advanceControlEpochForComputerMove } from "#src/server/agents/agent-control-operations.server";

test("moving an Agent with empty control state skips without warning", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => warnings.push(message);
  try {
    expect(advanceControlEpochForComputerMove(null, "agent", "computer")).toBeUndefined();
    expect(warnings).toHaveLength(0);
  } finally {
    console.warn = original;
  }
});

test("moving an Agent bumps the epoch and restarts the result sequence", () => {
  const state = {
    version: 1,
    protocolMajor: 1,
    requestId: "r1",
    workspaceId: "w",
    computerId: "c-old",
    agentId: "a",
    provider: "pi",
    epoch: 3,
    action: "start",
    phase: "completed",
    configRevision: "",
    controlSequence: 7,
    sessionSequence: 2,
  };
  expect(advanceControlEpochForComputerMove(state, "a", "c-new")).toMatchObject({
    computerId: "c-new",
    epoch: 4,
    controlSequence: 0,
  });
});

test("moving an Agent with invalid control state warns with its id", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => warnings.push(message);
  try {
    expect(advanceControlEpochForComputerMove({}, "agent-bad", "computer")).toBeUndefined();
    expect(JSON.parse(warnings[0]!)).toMatchObject({
      event: "agent_control:move_state_invalid",
      agent_id: "agent-bad",
      outcome: "skipped",
    });
  } finally {
    console.warn = original;
  }
});
