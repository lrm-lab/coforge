import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { ArtifactReads } from "#src/server/artifacts/artifact-reads.server";
import { openChannel } from "#src/server/conversations/channel-page.server";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { attachViewerViews } from "#src/server/conversations/viewer-views.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { agentDirectKey, peopleDirectKey } from "#src/features/conversations/direct-key";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const VIEWER_ID = "00000000-0000-4000-8000-000000000002";
const PEER_ID = "00000000-0000-4000-8000-000000000003";
const AGENT_ID = "00000000-0000-4000-8000-000000000004";
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000005";
const VIEWER_MEMBER_ID = "00000000-0000-4000-8000-000000000006";
const AGENT_MEMBER_ID = "00000000-0000-4000-8000-000000000007";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000008";
const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000009";
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000010";

function browserMessageRow() {
  return {
    id: MESSAGE_ID,
    sequence: 1,
    threadRootId: null,
    senderMemberId: VIEWER_MEMBER_ID,
    body: `See /w/demo/artifacts/${ARTIFACT_ID}`,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    attachments: [
      {
        id: ATTACHMENT_ID,
        fileName: "note.txt",
        contentType: "text/plain",
        sizeBytes: 12,
        width: null,
        height: null,
        forwardPosition: null,
      },
    ],
    sender: {
      userId: VIEWER_ID,
      agentId: null,
      user: { username: "alice", displayName: "Alice", avatarObjectKey: null },
      agent: null,
    },
    mentions: [],
    reactionVersion: 0,
    reactions: [],
    forwards: [],
    systemMessage: null,
  };
}

describe("conversation page-open and viewer-hydration concurrency", () => {
  test("openChannel overlaps mapBrowserMessages with readWindowThreads and followedThreadRootIds", async () => {
    const events: string[] = [];
    const db = {
      workspaceMembership: {
        findUnique: async () => ({ role: "MEMBER" }),
      },
      conversation: {
        findFirst: async () => ({
          id: CONVERSATION_ID,
          channelName: "general",
          description: null,
          archivedAt: null,
          visibility: "public",
          coordinatorAgent: null,
        }),
      },
      conversationMember: {
        findUnique: async () => ({
          id: VIEWER_MEMBER_ID,
          leftAt: null,
          notificationLevel: "all",
          collapseLongMessages: false,
          user: { username: "alice" },
          pins: [],
        }),
        findMany: async () => [
          {
            id: VIEWER_MEMBER_ID,
            readThroughSequence: 1,
            agentReadThroughSequence: 0,
            user: {
              id: VIEWER_ID,
              username: "alice",
              displayName: "Alice",
              description: "",
              avatarObjectKey: null,
            },
            agent: null,
          },
        ],
      },
      message: {
        findMany: async () => [browserMessageRow()],
      },
      messageMention: {
        findMany: async () => [],
      },
      $queryRaw: async (query: TemplateStringsArray) => {
        if (!query.join("").includes("thread_reads")) return [];
        events.push("threads:start");
        await Promise.resolve();
        events.push("threads:end");
        return [];
      },
      threadRead: {
        findMany: async () => [],
      },
      threadFollow: {
        findMany: async () => {
          events.push("follows:start");
          await Promise.resolve();
          events.push("follows:end");
          return [];
        },
      },
      attachmentComment: {
        groupBy: async () => {
          events.push("comments:start");
          await Promise.resolve();
          events.push("comments:end");
          return [];
        },
      },
    } as unknown as PrismaClient;

    await openChannel(
      { db, inboxPurge: { purge: async () => {} } },
      WORKSPACE_ID,
      VIEWER_ID,
      CONVERSATION_ID,
    );

    expect(events.indexOf("comments:start")).toBeGreaterThan(-1);
    expect(events.indexOf("comments:start")).toBeLessThan(events.indexOf("threads:end"));
    expect(events.indexOf("comments:start")).toBeLessThan(events.indexOf("follows:end"));
  });

  test("ConversationHistory.loadAround overlaps mapBrowserMessages with readWindowThreads", async () => {
    const events: string[] = [];
    const db = {
      workspaceMembership: {
        findUnique: async () => ({ role: "MEMBER" }),
      },
      conversation: {
        findFirst: async () => ({
          id: CONVERSATION_ID,
          channelName: "general",
          directKey: null,
          visibility: "public",
          members: [{ id: VIEWER_MEMBER_ID, leftAt: null }],
        }),
      },
      message: {
        findFirst: async () => ({ id: MESSAGE_ID, sequence: 1, threadRoot: null }),
        findMany: async ({ orderBy }: { orderBy: { sequence: string } }) =>
          orderBy.sequence === "desc" ? [browserMessageRow()] : [],
      },
      $queryRaw: async () => {
        events.push("threads:start");
        await Promise.resolve();
        events.push("threads:end");
        return [];
      },
      threadRead: {
        findMany: async () => [],
      },
      threadFollow: {
        findMany: async () => [],
      },
      attachmentComment: {
        groupBy: async () => {
          events.push("comments:start");
          await Promise.resolve();
          events.push("comments:end");
          return [];
        },
      },
    } as unknown as PrismaClient;

    await new ConversationHistory(db).loadAround(
      WORKSPACE_ID,
      VIEWER_ID,
      CONVERSATION_ID,
      MESSAGE_ID,
    );

    expect(events.indexOf("comments:start")).toBeGreaterThan(-1);
    expect(events.indexOf("comments:start")).toBeLessThan(events.indexOf("threads:end"));
  });

  test("openConversationForUser overlaps mapBrowserMessages with readWindowThreads and returns collapseLongMessages", async () => {
    const events: string[] = [];
    const db = {
      conversation: {
        findUnique: async () => ({
          directKey: peopleDirectKey(VIEWER_ID, PEER_ID),
          members: [
            {
              id: VIEWER_MEMBER_ID,
              userId: VIEWER_ID,
              agentId: null,
              leftAt: null,
              readThroughSequence: 1,
              agentReadThroughSequence: 0,
              collapseLongMessages: true,
              user: {
                id: VIEWER_ID,
                username: "alice",
                displayName: "Alice",
                description: null,
                avatarObjectKey: null,
              },
              agent: null,
            },
            {
              id: AGENT_MEMBER_ID,
              userId: PEER_ID,
              agentId: null,
              leftAt: null,
              readThroughSequence: 1,
              agentReadThroughSequence: 0,
              collapseLongMessages: false,
              user: {
                id: PEER_ID,
                username: "bob",
                displayName: "Bob",
                description: null,
                avatarObjectKey: null,
              },
              agent: null,
            },
          ],
        }),
      },
      message: {
        findMany: async () => [browserMessageRow()],
      },
      $queryRaw: async () => {
        events.push("threads:start");
        await Promise.resolve();
        events.push("threads:end");
        return [];
      },
      threadRead: {
        findMany: async () => [],
      },
      attachmentComment: {
        groupBy: async () => {
          events.push("comments:start");
          await Promise.resolve();
          events.push("comments:end");
          return [];
        },
      },
    } as unknown as PrismaClient;

    const opened = await new PrismaDirectConversationRepository(db).openConversationForUser(
      WORKSPACE_ID,
      VIEWER_ID,
      CONVERSATION_ID,
    );

    expect(opened.collapseLongMessages).toBe(true);
    expect(events.indexOf("comments:start")).toBeGreaterThan(-1);
    expect(events.indexOf("comments:start")).toBeLessThan(events.indexOf("threads:end"));
  });

  test("attachViewerViews runs artifactMessageCards concurrently with forwarded and action card lookups", async () => {
    const events: string[] = [];
    const db = {
      actionCard: {
        findMany: async () => {
          events.push("actionCards:start");
          await Promise.resolve();
          events.push("actionCards:end");
          return [];
        },
      },
      artifact: {
        findMany: async () => {
          events.push("artifacts:start");
          await Promise.resolve();
          events.push("artifacts:end");
          return [];
        },
      },
      workspaceMembership: {
        findUnique: async () => ({ role: "MEMBER" }),
      },
    } as unknown as PrismaClient;

    await attachViewerViews(db, WORKSPACE_ID, VIEWER_ID, [
      { id: MESSAGE_ID, body: `See /w/demo/artifacts/${ARTIFACT_ID}` },
    ]);

    expect(events.indexOf("artifacts:start")).toBeGreaterThan(-1);
    expect(events.indexOf("artifacts:start")).toBeLessThan(events.indexOf("actionCards:end"));
  });

  test("ArtifactReads.messageCards runs artifact lookup and artifactViewer concurrently", async () => {
    const events: string[] = [];
    const db = {
      artifact: {
        findMany: async () => {
          events.push("artifactRows:start");
          await Promise.resolve();
          events.push("artifactRows:end");
          return [];
        },
      },
      workspaceMembership: {
        findUnique: async () => {
          events.push("viewer:start");
          await Promise.resolve();
          events.push("viewer:end");
          return { role: "MEMBER" };
        },
      },
    } as unknown as PrismaClient;

    await new ArtifactReads(db).messageCards({
      workspaceId: WORKSPACE_ID,
      reader: { userId: VIEWER_ID },
      messages: [{ body: `See /w/demo/artifacts/${ARTIFACT_ID}` }],
    });

    expect(events.indexOf("viewer:start")).toBeGreaterThan(-1);
    expect(events.indexOf("viewer:start")).toBeLessThan(events.indexOf("artifactRows:end"));
  });

  test("DirectConversations.page skips welcome and redundant member preference queries on people DMs", async () => {
    let memberFindFirstCalls = 0;
    let welcomeCalls = 0;
    const directKey = peopleDirectKey(VIEWER_ID, PEER_ID);
    const db = {
      conversation: {
        findFirst: async () => ({
          directKey,
          members: [{ id: VIEWER_MEMBER_ID, userId: VIEWER_ID, agent: null }],
        }),
        findUnique: async () => ({
          directKey,
          members: [
            {
              id: VIEWER_MEMBER_ID,
              userId: VIEWER_ID,
              agentId: null,
              leftAt: null,
              readThroughSequence: 1,
              agentReadThroughSequence: 0,
              collapseLongMessages: true,
              user: {
                id: VIEWER_ID,
                username: "alice",
                displayName: "Alice",
                description: null,
                avatarObjectKey: null,
              },
              agent: null,
            },
            {
              id: AGENT_MEMBER_ID,
              userId: PEER_ID,
              agentId: null,
              leftAt: null,
              readThroughSequence: 1,
              agentReadThroughSequence: 0,
              collapseLongMessages: false,
              user: {
                id: PEER_ID,
                username: "bob",
                displayName: "Bob",
                description: null,
                avatarObjectKey: null,
              },
              agent: null,
            },
          ],
        }),
      },
      conversationMember: {
        findFirst: async () => {
          memberFindFirstCalls += 1;
          return { collapseLongMessages: true };
        },
      },
      workspaceAssistantSession: {
        findFirst: async () => {
          welcomeCalls += 1;
          return null;
        },
      },
      message: {
        findMany: async () => [],
      },
    } as unknown as PrismaClient;

    const page = await new DirectConversations(db).page(WORKSPACE_ID, VIEWER_ID, CONVERSATION_ID);

    expect(page.collapseLongMessages).toBe(true);
    expect(page.workspaceAssistantWelcome).toBeUndefined();
    expect(memberFindFirstCalls).toBe(0);
    expect(welcomeCalls).toBe(0);
  });

  test("DirectConversations.page overlaps welcome check with openConversationForUser and avoids redundant member query on agent DMs", async () => {
    const events: string[] = [];
    let memberFindFirstCalls = 0;
    const directKey = agentDirectKey(VIEWER_ID, AGENT_ID);
    const db = {
      conversation: {
        findFirst: async () => ({
          directKey,
          members: [
            { id: VIEWER_MEMBER_ID, userId: VIEWER_ID, agent: null },
            {
              id: AGENT_MEMBER_ID,
              userId: null,
              agent: {
                id: AGENT_ID,
                ownerId: VIEWER_ID,
                visibility: "workspace",
                deletedAt: null,
              },
            },
          ],
        }),
        findUnique: async () => {
          events.push("viewerSide:start");
          await Promise.resolve();
          events.push("viewerSide:end");
          return {
            directKey,
            members: [
              {
                id: VIEWER_MEMBER_ID,
                userId: VIEWER_ID,
                agentId: null,
                leftAt: null,
                readThroughSequence: 1,
                agentReadThroughSequence: 0,
                collapseLongMessages: true,
                user: {
                  id: VIEWER_ID,
                  username: "alice",
                  displayName: "Alice",
                  description: null,
                  avatarObjectKey: null,
                },
                agent: null,
              },
              {
                id: AGENT_MEMBER_ID,
                userId: null,
                agentId: AGENT_ID,
                leftAt: null,
                readThroughSequence: 0,
                agentReadThroughSequence: 0,
                collapseLongMessages: false,
                user: null,
                agent: {
                  id: AGENT_ID,
                  name: "helper",
                  displayName: "Helper",
                  description: null,
                  deletedAt: null,
                  avatarMascot: null,
                  ownerId: VIEWER_ID,
                  visibility: "workspace",
                  appBot: null,
                },
              },
            ],
          };
        },
      },
      conversationMember: {
        findFirst: async () => {
          memberFindFirstCalls += 1;
          return { collapseLongMessages: true };
        },
      },
      workspaceAssistantSession: {
        findFirst: async () => {
          events.push("welcome:start");
          await Promise.resolve();
          events.push("welcome:end");
          return { agentId: AGENT_ID };
        },
      },
      message: {
        findMany: async () => [],
        findFirst: async () => null,
      },
    } as unknown as PrismaClient;

    const page = await new DirectConversations(db).page(WORKSPACE_ID, VIEWER_ID, CONVERSATION_ID);

    expect(page.collapseLongMessages).toBe(true);
    expect(page.workspaceAssistantWelcome).toBe(true);
    expect(memberFindFirstCalls).toBe(0);
    expect(events.indexOf("welcome:start")).toBeGreaterThan(-1);
    expect(events.indexOf("welcome:start")).toBeLessThan(events.indexOf("viewerSide:end"));
  });
});
