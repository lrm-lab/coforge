import { expect, test } from "bun:test";

import {
  findOwnedWorkspaceComputer,
  ownedComputerAgentAssignment,
} from "#src/server/computers/computer-workspace-files.server";

// The two lookups that decide whose Agent workspaces the Computer page may scan or delete: the
// viewer must own the Computer, and it must serve the viewer's Workspace.

function recording<Row>(row: Row) {
  const queries: unknown[] = [];
  return {
    queries,
    findFirst: async (query: unknown) => {
      queries.push(query);
      return row;
    },
  };
}

test("an owned Computer in this Workspace is found by owner and Workspace binding", async () => {
  const computer = recording({ id: "computer-1" });
  expect(
    await findOwnedWorkspaceComputer({ computer } as never, {
      userId: "user-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
    }),
  ).toEqual({ id: "computer-1" });
  expect(computer.queries).toEqual([
    {
      where: {
        id: "computer-1",
        ownerId: "user-1",
        workspaces: { some: { workspaceId: "workspace-1" } },
      },
      select: { id: true },
    },
  ]);
});

test("a Computer the viewer does not own, or outside the Workspace, is not available", async () => {
  await expect(
    findOwnedWorkspaceComputer({ computer: recording(null) } as never, {
      userId: "user-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
    }),
  ).rejects.toThrow("Computer is not available");
});

test("an Agent assignment requires this Computer, the viewer's Workspace and Computer ownership", async () => {
  const runtimeConfig = { runtime: "codex", model: "gpt" };
  const agent = recording({ computerId: "computer-1", runtimeConfig });
  const viewer = { userId: "user-1", workspaceId: "workspace-1" };
  expect(
    await ownedComputerAgentAssignment({ agent } as never, "computer-1", viewer, "agent-1"),
  ).toEqual({
    computerId: "computer-1",
    revision: new Bun.CryptoHasher("sha256").update(JSON.stringify(runtimeConfig)).digest("hex"),
  });
  expect(agent.queries).toEqual([
    {
      where: {
        id: "agent-1",
        workspaceId: "workspace-1",
        computerId: "computer-1",
        computer: { ownerId: "user-1", workspaces: { some: { workspaceId: "workspace-1" } } },
      },
      select: { computerId: true, runtimeConfig: true },
    },
  ]);
});

test("no matching Agent, or one without a Computer, has no assignment", async () => {
  const viewer = { userId: "user-1", workspaceId: "workspace-1" };
  for (const row of [null, { computerId: null, runtimeConfig: {} }])
    expect(
      await ownedComputerAgentAssignment(
        { agent: recording(row) } as never,
        "computer-1",
        viewer,
        "agent-1",
      ),
    ).toBeUndefined();
});
