import { expect, test } from "bun:test";
import { WorkspaceAgentRecovery } from "#src/server/agents/agent-runtime-control.server";
import type { AgentControl } from "#src/server/agents/agent-control.server";
import type { AgentRecord } from "#src/server/db/repositories/agent.repositories.server";

const workspaceId = "workspace-deleted";
const computerId = "computer-old";
const deleted: AgentRecord = {
  id: "deleted",
  workspaceId,
  name: "deleted",
  displayName: "Deleted",
  createdAt: new Date("2026-11-05T18:12:21Z"),
  ownerId: "owner",
  computerId,
  runtimeConfig: {
    runtime: "pi",
    provider: { kind: "default" },
    model: "",
    modelProvider: "",
    reasoning: "",
  },
  stoppedAt: null,
  deletedAt: new Date(),
};

test("ready reconciliation keeps deleted Agent cleanup on the fenced Stop path", async () => {
  let stops = 0;
  const control = {
    publishStop: async () => {
      stops++;
    },
  } as unknown as AgentControl;
  const recovery = new WorkspaceAgentRecovery(
    {
      getById: async () => deleted,
      listOwnedInWorkspace: async () => [],
      listInWorkspace: async () => [],
      listForComputer: async () => [],
      listDeletedForComputer: async () => [deleted],
      create: async () => {
        throw new Error("not used");
      },
      update: async () => {
        throw new Error("not used");
      },
    },
    { readAgentRecoveryContext: async () => ({ resumeMessages: [], unreadSummary: {} }) },
    { publish: async () => {} },
    { run: async (_id, work) => work() },
    { resendPending: async () => {} },
    undefined,
    control,
  );

  await recovery.recoverWorkspace(workspaceId, computerId, [deleted.id]);

  expect(stops).toBe(1);
});
