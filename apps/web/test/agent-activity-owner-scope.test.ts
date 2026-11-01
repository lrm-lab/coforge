import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { publicationAgentLookups } from "#src/server/agents/agent-activity-publish.server";

test("a public Agent may publish from a Computer owned by another Workspace member", async () => {
  const db = {
    agent: {
      findUnique: async () => ({
        workspaceId: "workspace-1",
        computerId: "computer-1",
        visibility: "public",
        runtimeSession: {
          computerId: "computer-1",
          daemonInstanceId: "daemon-1",
          launchId: "launch-1",
        },
      }),
    },
  } as unknown as PrismaClient;
  const lookups = publicationAgentLookups(db);

  // Computer ownership is deliberately a Workspace-connection concern. The Agent's owner is not
  // part of publication scope: a public Agent may run on another member's Computer.
  expect(await lookups.agentBelongsToWorkspace("workspace-1", "agent-1")).toBe(true);
  expect(await lookups.agentBelongsToComputer("workspace-1", "agent-1", "computer-1")).toBe(
    true,
  );
  expect(await lookups.currentRuntimeFence!("workspace-1", "computer-1", "agent-1")).toEqual({
    daemonInstanceId: "daemon-1",
    launchId: "launch-1",
  });
  expect(await lookups.agentVisibility("workspace-1", "agent-1")).toBe("public");
});
