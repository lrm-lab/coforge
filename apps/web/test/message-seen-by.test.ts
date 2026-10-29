import { expect, test } from "bun:test";

import { readMessageSeenBy } from "#src/server/conversations/message-seen-by.server";

const ids = {
  workspace: "workspace-1",
  conversation: "conversation-1",
  viewer: "user-1",
  viewerMember: "member-1",
  message: "message-1",
};
const input = {
  workspaceId: ids.workspace,
  userId: ids.viewer,
  conversationId: ids.conversation,
  messageId: ids.message,
};

function dbFor({
  viewerMember = { id: ids.viewerMember, leftAt: null },
  message = { senderMemberId: ids.viewerMember, sequence: 7, threadRootId: null },
  members = [],
}: {
  viewerMember?: { id: string; leftAt: null } | null;
  message?: { senderMemberId: string | null; sequence: number; threadRootId: string | null } | null;
  members?: readonly {
    id: string;
    userId: string | null;
    agentId: string | null;
    readThroughSequence: number;
    agentReadThroughSequence: number;
  }[];
}) {
  return {
    workspaceMembership: {
      findUnique: async () => ({ userId: ids.viewer }),
    },
    conversation: {
      findFirst: async () => ({
        directKey: "dm:one",
        channelName: null,
        members: viewerMember ? [viewerMember] : [],
      }),
    },
    message: {
      findFirst: async ({ where }: { where: { threadRootId?: null } }) =>
        where.threadRootId === null && message?.threadRootId === null ? message : null,
    },
    conversationMember: {
      findMany: async ({ where }: { where: { id?: { not?: string } } }) =>
        members.filter((member) => member.id !== where.id?.not),
    },
    // No read time kept: the message was read before they were, or not at all.
    messageRead: { findFirst: async () => null },
  };
}

test("returns active people and Agents whose main read position reached the message", async () => {
  const result = await readMessageSeenBy(
    dbFor({
      members: [
        {
          id: "member-1",
          userId: "user-1",
          agentId: null,
          readThroughSequence: 99,
          agentReadThroughSequence: 0,
        },
        {
          id: "member-2",
          userId: "user-2",
          agentId: null,
          readThroughSequence: 7,
          agentReadThroughSequence: 0,
        },
        {
          id: "member-3",
          userId: null,
          agentId: "agent-1",
          readThroughSequence: 0,
          agentReadThroughSequence: 8,
        },
        {
          id: "member-4",
          userId: "user-4",
          agentId: null,
          readThroughSequence: 6,
          agentReadThroughSequence: 0,
        },
      ],
    }) as never,
    input,
  );

  expect(result).toEqual({
    seen: [
      { kind: "user", id: "user-2" },
      { kind: "agent", id: "agent-1" },
    ],
  });
});

test("does not expose a reply or another member's message", async () => {
  await expect(
    readMessageSeenBy(
      dbFor({ message: { senderMemberId: "member-2", sequence: 7, threadRootId: null } }) as never,
      input,
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    readMessageSeenBy(
      dbFor({
        message: { senderMemberId: ids.viewerMember, sequence: 7, threadRootId: "root-1" },
      }) as never,
      input,
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("requires an active conversation member", async () => {
  await expect(
    readMessageSeenBy(dbFor({ viewerMember: null }) as never, input),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
});
