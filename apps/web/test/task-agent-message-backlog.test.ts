import { expect, test } from "bun:test";
import { toAgentMessage } from "#src/server/db/repositories/direct-conversation-agent-message.server";

test("Agent message projections preserve Backlog and multiple source tasks metadata", () => {
  const message = toAgentMessage(
    {
      id: "message",
      sequence: 1,
      body: "Parked work",
      createdAt: new Date(0),
      sender: { agentId: null, agent: null, user: { username: "frank", description: "" } },
      attachments: [],
      sourceOfTasks: [
        { number: 12, status: "backlog", owner: null },
        {
          number: 13,
          status: "in_progress",
          owner: { user: null, agent: { name: "atlas", displayName: "Atlas", deletedAt: null } },
        },
      ],
    } as Parameters<typeof toAgentMessage>[0],
    "#work",
  );
  expect(message.tasks).toEqual([
    { number: 12, status: "backlog" },
    { number: 13, status: "in_progress", owner: { displayName: "Atlas", handle: "atlas" } },
  ]);
});
