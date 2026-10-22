import { expect, test } from "bun:test";

import { AgentDetailQuery } from "#src/server/agents/agent-detail.server";

/** Whether the profile offers the viewer a direct message with the Agent: any member a public
 * one, only its creator a private one, and nobody a deleted one. */
function profileFor(agent: { ownerId: string; visibility: string; deletedAt?: Date }) {
  return new AgentDetailQuery({
    findAuthorized: async () => ({
      id: "agent-1",
      workspaceId: "workspace-1",
      name: "builder",
      displayName: "Builder",
      role: "member",
      createdAt: new Date("2026-08-29T00:00:00Z"),
      computerId: null,
      owner: { id: agent.ownerId, username: "alice" },
      runtimeConfig: {},
      visibility: agent.visibility,
      deletedAt: agent.deletedAt ?? null,
    }),
  }).get("workspace-1", "agent-1", "viewer");
}

test.each([
  ["another member's public Agent", { ownerId: "owner", visibility: "public" }, true],
  ["another member's private Agent", { ownerId: "owner", visibility: "private" }, false],
  ["the viewer's own private Agent", { ownerId: "viewer", visibility: "private" }, true],
  [
    "a deleted public Agent",
    { ownerId: "owner", visibility: "public", deletedAt: new Date("2026-09-01T00:00:00Z") },
    false,
  ],
] as const)("the profile offers a message with %s: %p", async (_name, agent, canMessage) => {
  expect((await profileFor(agent))?.canMessage).toBe(canMessage);
});
