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
  message = { senderMemberId: ids.viewerMember, sequence: 7, threadRootId: null, mentions: [] },
  members = [],
  conversation = { directKey: "dm:one", channelName: null, coordinatorAgentId: null },
  threadReads = [],
  unfollowNotices = [],
  followedAgentIds = [],
}: {
  viewerMember?: { id: string; leftAt: null } | null;
  message?: {
    senderMemberId: string | null;
    sequence: number;
    threadRootId: string | null;
    mentions?: readonly { kind: string; actorId: string }[];
  } | null;
  members?: readonly {
    id: string;
    userId: string | null;
    agentId: string | null;
    notificationLevel?: string;
    readThroughSequence: number;
    agentReadThroughSequence: number;
  }[];
  conversation?: {
    directKey: string | null;
    channelName: string | null;
    coordinatorAgentId: string | null;
  };
  threadReads?: readonly { memberId: string; readThroughSequence: number }[];
  unfollowNotices?: readonly { params: unknown }[];
  followedAgentIds?: readonly string[];
}) {
  return {
    workspaceMembership: {
      findUnique: async () => ({ userId: ids.viewer }),
    },
    conversation: {
      findFirst: async () => ({
        ...conversation,
        members: viewerMember ? [viewerMember] : [],
      }),
    },
    message: {
      findFirst: async () =>
        message
          ? {
              ...message,
              conversation,
              mentions: message.mentions ?? [],
            }
          : null,
    },
    conversationMember: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.agent) return [];
        const audienceQuery = "notificationLevel" in where || "threadFollows" in where;
        return members
          .filter((member) => member.id !== (where.id as { not?: string } | undefined)?.not)
          .filter((member) => {
            if (!audienceQuery) return true;
            if (where.notificationLevel === "all" && member.notificationLevel !== "all")
              return false;
            if (where.threadFollows) return followedAgentIds.includes(member.agentId ?? "");
            return true;
          })
          .map((member) => ({ notificationLevel: "all", ...member }));
      },
      findFirst: async () =>
        conversation.coordinatorAgentId
          ? (members.find((member) => member.agentId === conversation.coordinatorAgentId) ?? null)
          : null,
    },
    threadRead: { findMany: async () => threadReads },
    $queryRaw: async () =>
      unfollowNotices.flatMap((notice) =>
        notice.params && typeof notice.params === "object"
          ? [notice.params as { agentId: string; rootMessageId: string }]
          : [],
      ),
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
    undeliveredAgents: [],
  });
});

test("does not expose another member's message, but permits the viewer's thread reply", async () => {
  await expect(
    readMessageSeenBy(
      dbFor({ message: { senderMemberId: "member-2", sequence: 7, threadRootId: null } }) as never,
      input,
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    readMessageSeenBy(
      dbFor({
        message: { senderMemberId: "member-2", sequence: 7, threadRootId: "root-1" },
      }) as never,
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
  ).resolves.toMatchObject({ seen: [], undeliveredAgents: [] });
});

test("reports a muted Agent that is outside the top-level delivery audience", async () => {
  const result = await readMessageSeenBy(
    dbFor({
      conversation: { directKey: null, channelName: "general", coordinatorAgentId: null },
      members: [
        {
          id: "member-2",
          userId: null,
          agentId: "muted-agent",
          notificationLevel: "muted",
          readThroughSequence: 0,
          agentReadThroughSequence: 0,
        },
        {
          id: "member-3",
          userId: null,
          agentId: "loud-agent",
          notificationLevel: "all",
          readThroughSequence: 0,
          agentReadThroughSequence: 0,
        },
      ],
    }) as never,
    input,
  );
  expect(result.undeliveredAgents).toEqual([{ id: "muted-agent", reason: "channel_muted" }]);
});

test("reports only a structured prior unfollow for a thread reply", async () => {
  const result = await readMessageSeenBy(
    dbFor({
      message: { senderMemberId: ids.viewerMember, sequence: 7, threadRootId: "root-1" },
      conversation: { directKey: null, channelName: "general", coordinatorAgentId: null },
      members: [
        {
          id: "member-2",
          userId: null,
          agentId: "unfollowed-agent",
          notificationLevel: "all",
          readThroughSequence: 0,
          agentReadThroughSequence: 0,
        },
        {
          id: "member-3",
          userId: null,
          agentId: "never-followed-agent",
          notificationLevel: "all",
          readThroughSequence: 0,
          agentReadThroughSequence: 0,
        },
      ],
      unfollowNotices: [{ params: { agentId: "unfollowed-agent", rootMessageId: "root-1" } }],
    }) as never,
    input,
  );
  expect(result.undeliveredAgents).toEqual([
    { id: "unfollowed-agent", reason: "thread_unfollowed" },
  ]);
});

test("requires an active conversation member", async () => {
  await expect(
    readMessageSeenBy(dbFor({ viewerMember: null }) as never, input),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
});
