import { describe, expect, test } from "bun:test";
import {
  RUNNER_HOLD_REASONS,
  type DaemonHoldResponse,
  type HeldBusyAgent,
} from "@lrm/coforge-sdk/internal";
import { askWorkspaceRunnerHold } from "#src/supervisor/runner-hold";

const agent = (overrides: Partial<HeldBusyAgent> = {}): HeldBusyAgent => ({
  workspaceId: "w1",
  agentId: "a1",
  detailKind: "tool_call",
  busySinceMs: 1,
  ...overrides,
});
const response = (overrides: Partial<DaemonHoldResponse> = {}): DaemonHoldResponse => ({
  protocolMajor: 1,
  requestId: "r",
  accepted: true,
  held: true,
  busyAgents: [],
  unreachableWorkspaceIds: [],
  ...overrides,
});
const ask = (
  hold: () => Promise<DaemonHoldResponse>,
  operation: "hold" | "release" = "hold",
  timeoutMs?: number,
) =>
  askWorkspaceRunnerHold({
    workspaceId: "w1",
    operation,
    reason: undefined,
    eventPrefix: "restart",
    hold,
    timeoutMs,
  });

describe("askWorkspaceRunnerHold", () => {
  test("reports the Workspace's busy Agents, naming the Workspace for one that did not", async () => {
    const answered = await ask(async () =>
      response({ busyAgents: [agent({ workspaceId: "" }), agent({ agentId: "a2" })] }),
    );

    expect(answered).toEqual({
      held: true,
      busyAgents: [agent(), agent({ agentId: "a2" })],
      unreachableWorkspaceIds: [],
    });
  });

  test("a release reports held false", async () => {
    expect((await ask(async () => response({ held: false }), "release")).held).toBe(false);
  });

  test("passes the operation and reason to the Workspace daemon", async () => {
    const asked: unknown[] = [];
    await askWorkspaceRunnerHold({
      workspaceId: "w1",
      operation: "release",
      reason: RUNNER_HOLD_REASONS.WORKSPACE_RESTART,
      eventPrefix: "restart",
      hold: async (operation, reason) => {
        asked.push([operation, reason]);
        return response();
      },
    });
    expect(asked).toEqual([["release", "restart"]]);
  });

  test("counts a Workspace that refuses, fails, or never answers as unreachable and idle", async () => {
    const unreachable = { held: true, busyAgents: [], unreachableWorkspaceIds: ["w1"] };
    expect(await ask(async () => response({ accepted: false, busyAgents: [agent()] }))).toEqual(
      unreachable,
    );
    expect(
      await ask(async () => {
        throw new Error("socket gone");
      }),
    ).toEqual(unreachable);
    expect(await ask(() => new Promise<never>(() => {}), "hold", 5)).toEqual(unreachable);
  });
});
