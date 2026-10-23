import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";

const membership = { id: "workspace-member-1" };

describe("ConversationHistory", () => {
  test("indexes only the current User's messages in the requested direct conversation", async () => {
    const messageQueries: object[] = [];
    const db = {
      workspaceMembership: { findUnique: async () => membership },
      conversation: {
        findFirst: async () => ({
          directKey: "agent:agent-1|user:user-1",
          channelName: null,
          members: [{ id: "conversation-member-1" }],
        }),
      },
      message: {
        findMany: async (input: object) => {
          messageQueries.push(input);
          return [
            {
              id: "message-9",
              sequence: 9,
              body: "Newest prompt",
              createdAt: new Date(9),
              attachments: [],
            },
            {
              id: "message-7",
              sequence: 7,
              body: "Older prompt",
              createdAt: new Date(7),
              // Two attachments: the derived index field names the first (send order) and
              // counts the rest, rather than picking one arbitrarily or dropping the count.
              attachments: [{ fileName: "brief.pdf" }, { fileName: "appendix.pdf" }],
            },
            {
              id: "message-5",
              sequence: 5,
              body: "Previous page",
              createdAt: new Date(5),
              attachments: [],
            },
          ];
        },
      },
    } as unknown as PrismaClient;

    const page = await new ConversationHistory(db).listOwnMessages(
      "workspace-1",
      "user-1",
      "direct-conversation-1",
      { beforeSequence: 12, limit: 2 },
    );

    expect(messageQueries[0]).toMatchObject({
      where: {
        conversationId: "direct-conversation-1",
        threadRootId: null,
        sequence: { lt: 12 },
        // The viewer's own member row, not a join through `sender.userId`: the filter is served
        // by `messages(senderMemberId, threadRootId, sequence)` instead of walking the whole
        // conversation's history backwards to find the viewer's few rows.
        senderMemberId: "conversation-member-1",
      },
      orderBy: { sequence: "desc" },
      take: 3,
    });
    expect(page).toEqual({
      hasOlder: true,
      messages: [
        {
          id: "message-7",
          sequence: 7,
          body: "Older prompt",
          createdAt: new Date(7),
          attachmentFileName: "brief.pdf (+1 more)",
        },
        {
          id: "message-9",
          sequence: 9,
          body: "Newest prompt",
          createdAt: new Date(9),
          attachmentFileName: undefined,
        },
      ],
    });
  });

  test("allows a Workspace member to index a public channel without joining it", async () => {
    const conversationQueries: object[] = [];
    const messageQueries: object[] = [];
    const db = {
      workspaceMembership: { findUnique: async () => membership },
      conversation: {
        findFirst: async (input: object) => {
          conversationQueries.push(input);
          return { directKey: null, channelName: "general", members: [] };
        },
      },
      message: {
        findMany: async (input: object) => {
          messageQueries.push(input);
          return [];
        },
      },
    } as unknown as PrismaClient;

    const page = await new ConversationHistory(db).listOwnMessages(
      "workspace-1",
      "user-1",
      "channel-conversation-1",
    );

    expect(conversationQueries[0]).toMatchObject({
      where: { id: "channel-conversation-1", workspaceId: "workspace-1" },
      select: {
        directKey: true,
        channelName: true,
        members: { where: { userId: "user-1" }, select: { id: true } },
      },
    });
    // No member row means no message of theirs can exist here: nothing to scan.
    expect(page).toEqual({ hasOlder: false, messages: [] });
    expect(messageQueries).toEqual([]);
  });

  test("indexes a joined channel by the viewer's member row", async () => {
    const messageQueries: object[] = [];
    const db = {
      workspaceMembership: { findUnique: async () => membership },
      conversation: {
        findFirst: async () => ({
          directKey: null,
          channelName: "general",
          members: [{ id: "channel-member-1" }],
        }),
      },
      message: {
        findMany: async (input: object) => {
          messageQueries.push(input);
          return [];
        },
      },
    } as unknown as PrismaClient;

    await new ConversationHistory(db).listOwnMessages(
      "workspace-1",
      "user-1",
      "channel-conversation-1",
    );

    expect(messageQueries[0]).toMatchObject({
      where: {
        conversationId: "channel-conversation-1",
        threadRootId: null,
        senderMemberId: "channel-member-1",
      },
    });
  });

  test("rejects a direct conversation that does not contain the current User", async () => {
    const db = {
      workspaceMembership: { findUnique: async () => membership },
      conversation: {
        findFirst: async () => ({
          directKey: "agent:agent-2|user:user-2",
          channelName: null,
          members: [],
        }),
      },
    } as unknown as PrismaClient;

    await expect(
      new ConversationHistory(db).listOwnMessages(
        "workspace-1",
        "user-1",
        "other-direct-conversation",
      ),
    ).rejects.toThrow("ACCESS_DENIED");
  });

  test("rejects the around window for a non-member before any message read", async () => {
    // The around read's anchor lookup deliberately has no sender filter (a saved jump #127 lands
    // on other members' and Agent messages), so the membership decision must sit entirely in
    // `authorize` — a non-member never reaches a message query.
    const messageQueries: object[] = [];
    const db = {
      workspaceMembership: { findUnique: async () => membership },
      conversation: {
        findFirst: async () => ({
          directKey: "agent:agent-2|user:user-2",
          channelName: null,
          members: [],
        }),
      },
      message: {
        findFirst: async (input: object) => {
          messageQueries.push(input);
          return { sequence: 10 };
        },
      },
    } as unknown as PrismaClient;

    await expect(
      new ConversationHistory(db).loadAround(
        "workspace-1",
        "user-1",
        "other-direct-conversation",
        "message-10",
      ),
    ).rejects.toThrow("ACCESS_DENIED");
    expect(messageQueries).toHaveLength(0);
  });

  test("loads an around window for any message in the requested conversation", async () => {
    const messageQueries: object[] = [];
    const message = (id: string, sequence: number) => ({
      id,
      sequence,
      threadRootId: null,
      senderMemberId: "user-member-1",
      body: id,
      createdAt: new Date(sequence),
      attachments: [],
      mentions: [],
      sender:
        sequence === 11
          ? {
              userId: null,
              agentId: "agent-builder",
              user: null,
              agent: { name: "builder", displayName: "Build Assistant", avatarMascot: null },
            }
          : {
              userId: "user-1",
              agentId: null,
              user: {
                username: "alice",
                displayName: "Alice Chen",
                avatarObjectKey: "users/user-1/avatars/avatar-1/original",
              },
              agent: null,
            },
    });
    const db = {
      workspaceMembership: { findUnique: async () => membership },
      conversation: {
        findFirst: async () => ({
          directKey: null,
          channelName: "engineering",
          members: [],
        }),
      },
      $queryRaw: async () => [],
      message: {
        findFirst: async (input: object) => {
          messageQueries.push(input);
          return { id: "message-10", sequence: 10, threadRoot: null };
        },
        findMany: async (input: { orderBy: { sequence: string } }) => {
          messageQueries.push(input);
          return input.orderBy.sequence === "desc"
            ? [message("message-10", 10), message("message-9", 9), message("message-7", 7)]
            : [message("message-11", 11), message("message-13", 13)];
        },
      },
    } as unknown as PrismaClient;

    const page = await new ConversationHistory(db).loadAround(
      "workspace-1",
      "user-1",
      "channel-conversation-1",
      "message-10",
      3,
    );

    expect(messageQueries[0]).toMatchObject({
      where: { id: "message-10", conversationId: "channel-conversation-1" },
    });
    // No sender filter on the anchor: a saved jump (#127) lands on other members' and Agent
    // messages too, so the where clause must not require the viewer to be the sender.
    expect(JSON.stringify(messageQueries[0])).not.toContain("sender");
    expect(page).toMatchObject({
      conversationId: "channel-conversation-1",
      hasOlder: true,
      hasNewer: true,
      anchorThreadRootId: undefined,
      threads: {},
      threadReadThrough: {},
      followedThreadRootIds: [],
    });
    expect(
      page.messages.map(({ id, sequence, senderMemberId }) => [id, sequence, senderMemberId]),
    ).toEqual([
      ["message-9", 9, "user-member-1"],
      ["message-10", 10, "user-member-1"],
      ["message-11", 11, "user-member-1"],
    ]);
    // Only the Agent-sent message (sequence 11) carries a senderAgentId; the panel opener
    // (message-row.tsx) uses this to know which senders it may open a profile for.
    expect(page.messages.map(({ senderAgentId }) => senderAgentId)).toEqual([
      undefined,
      undefined,
      "agent-builder",
    ]);
    // The browser is attributed by display name now (Slack's convention): the previous
    // "@alice"/"@builder" expectation encoded the old rule, where a person read as a handle
    // beside an Agent reading as its display name. `@handle` still goes to Agent reads.
    expect(page.messages.map(({ senderName }) => senderName)).toEqual([
      "Alice Chen",
      "Alice Chen",
      "Build Assistant",
    ]);
    expect(page.messages.map(({ senderAvatarUrl }) => senderAvatarUrl)).toEqual([
      "/api/workspaces/workspace-1/users/user-1/avatar?v=avatar-1",
      "/api/workspaces/workspace-1/users/user-1/avatar?v=avatar-1",
      agentAvatarUrl("agent-builder"),
    ]);
  });
  test("an around read anchored on a reply centres on its thread's root and names it", async () => {
    const queries: { where?: { sequence?: object } }[] = [];
    const db = {
      workspaceMembership: { findUnique: async () => membership },
      conversation: {
        findFirst: async () => ({ directKey: null, channelName: "engineering", members: [] }),
      },
      $queryRaw: async () => [],
      message: {
        // The reply at 12 answers the root at 10.
        findFirst: async () => ({
          id: "reply-12",
          sequence: 12,
          threadRoot: { id: "root-10", sequence: 10 },
        }),
        findMany: async (input: { where: { sequence: object } }) => {
          queries.push(input);
          return [];
        },
      },
    } as unknown as PrismaClient;

    const page = await new ConversationHistory(db).loadAround(
      "workspace-1",
      "user-1",
      "channel-conversation-1",
      "reply-12",
    );

    expect(queries.map((query) => query.where?.sequence)).toEqual([{ lte: 10 }, { gt: 10 }]);
    expect(page.anchorThreadRootId).toBe("root-10");
  });
  test("a thread read in a DM between people names each reply's sender member", async () => {
    const reply = (id: string, sequence: number, memberId: string, userId: string) => ({
      id,
      sequence,
      threadRootId: "root-1",
      senderMemberId: memberId,
      body: id,
      createdAt: new Date(sequence),
      attachments: [],
      sender: {
        userId,
        agentId: null,
        user: { username: userId, displayName: userId, avatarObjectKey: null },
        agent: null,
      },
      mentions: [],
      reactionVersion: 0,
      reactions: [],
    });
    const db = {
      workspaceMembership: { findUnique: async () => membership },
      conversation: {
        findFirst: async () => ({
          directKey: "user:user-1|user:user-2",
          channelName: null,
          members: [{ id: "member-1", leftAt: null }],
        }),
      },
      message: {
        findFirst: async () => ({ id: "root-1" }),
        findMany: async () => [
          reply("reply-2", 2, "member-1", "user-1"),
          reply("reply-3", 3, "member-2", "user-2"),
        ],
      },
    } as unknown as PrismaClient;

    const { replies } = await new ConversationHistory(db).loadThread(
      "workspace-1",
      "user-1",
      "direct-conversation-1",
      "root-1",
    );

    // Both are people's messages; only the member id tells the viewer's (member-1) from the other's.
    expect(
      replies.map(({ id, senderKind, senderMemberId, senderUserId }) => ({
        id,
        senderKind,
        senderMemberId,
        senderUserId,
      })),
    ).toEqual([
      { id: "reply-2", senderKind: "user", senderMemberId: "member-1", senderUserId: "user-1" },
      { id: "reply-3", senderKind: "user", senderMemberId: "member-2", senderUserId: "user-2" },
    ]);
  });
});
