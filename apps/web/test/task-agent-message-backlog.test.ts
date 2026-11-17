import { expect, test } from "bun:test";
import { toAgentMessage } from "#src/server/db/repositories/direct-conversation-agent-message.server";

test("Agent message projections preserve Backlog metadata", () => {
  const message = toAgentMessage(
    {
      id: "message",
      sequence: 1,
      body: "Parked work",
      createdAt: new Date(0),
      sender: { agentId: null, agent: null, user: { username: "frank", description: "" } },
      attachments: [],
      task: { number: 12, status: "backlog", owner: null },
    } as Parameters<typeof toAgentMessage>[0],
    "#work",
  );
  expect(message.task).toEqual({ number: 12, status: "backlog" });
});
