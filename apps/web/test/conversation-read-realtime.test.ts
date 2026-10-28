import { expect, test } from "bun:test";

import { publishConversationReadChanged } from "#src/server/conversations/conversation-read-realtime.server";

test("publishes the shared conversation read event on the conversation channel", async () => {
  const publications: unknown[][] = [];
  const centrifugo = {
    publishJson: async (...args: unknown[]) => {
      publications.push(args);
    },
  };

  await publishConversationReadChanged(centrifugo, {
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    memberId: "member-1",
    readThroughSequence: 7,
  });

  expect(publications).toEqual([
    [
      "chat:conversation-1",
      {
        type: "conversation.read.v1",
        conversationId: "conversation-1",
        memberId: "member-1",
        readThroughSequence: 7,
      },
      "conversation-1:read:member-1:7",
    ],
  ]);
});
