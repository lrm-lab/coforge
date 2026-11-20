import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { listAgentInbox } from "#src/server/agents/agent-inbox-list.server";
import { listWakeHints } from "#src/server/agents/external-wake-hints.server";
import { directTargets } from "#src/server/db/repositories/agent-peer-direct.repositories.server";
import { conversationTarget } from "#src/server/db/repositories/direct-conversation-agent-message.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { RECOVERY_CREATED_AT, recoverySecondPassStubs } from "./helpers/recovery-second-pass-stubs";

describe("app_events target resolution, recovery, wake hints, and inbox list", () => {
  test("directTargets and conversationTarget resolve system.artifacts and installed app_events", async () => {
    const db = {
      agent: { findMany: async () => [] },
      user: { findMany: async () => [] },
      workspaceMembership: { findMany: async () => [] },
      conversation: { findMany: async () => [] },
      app: {
        findMany: async () => [{ id: "app-1", key: "github" }],
      },
    } as unknown as PrismaClient;

    const systemConv = {
      kind: "app_events",
      channelName: null,
      directKey: "system:system.artifacts|agent:agent-1",
      attachmentCommentThread: null,
      members: [{ user: null, agent: { id: "agent-1", name: "scout" } }],
      taskDiscussionOf: null,
    };
    const appConv = {
      kind: "app_events",
      channelName: null,
      directKey: "app:app-1|agent:agent-1",
      attachmentCommentThread: null,
      members: [{ user: null, agent: { id: "agent-1", name: "scout" } }],
      taskDiscussionOf: null,
    };

    const targetOf = await directTargets(db, "ws-1", "agent-1", [systemConv, appConv]);
    expect(conversationTarget(systemConv, targetOf)).toBe("@app.system.artifacts");
    expect(conversationTarget(appConv, targetOf)).toBe("@app.github");
  });

  test("readAgentRecoveryContext recovers system.artifacts and installed app_events without throwing", async () => {
    const rows = [
      {
        id: "msg-sys-1",
        sequence: 1,
        body: "CoForge artifacts: new comment",
        conversationId: "conv-sys",
        threadRootId: null,
        senderMemberId: null,
        createdAt: RECOVERY_CREATED_AT,
        deliveryId: "del-sys-1",
        senderAgentName: null,
        senderAgentDescription: null,
        senderUsername: null,
        senderUserDescription: null,
        channelName: null,
        otherUsername: null,
        agentPeer: false,
        unreadCount: 2,
        globalRank: 1,
        nonMemberMention: false,
        attachmentId: null,
        conversationKind: "app_events",
        directKey: "system:system.artifacts|agent:agent-1",
        appKey: null,
      },
      {
        id: "msg-app-1",
        sequence: 3,
        body: "[CoForge app event] PR opened",
        conversationId: "conv-app",
        threadRootId: null,
        senderMemberId: null,
        createdAt: RECOVERY_CREATED_AT,
        deliveryId: "del-app-1",
        senderAgentName: null,
        senderAgentDescription: null,
        senderUsername: null,
        senderUserDescription: null,
        channelName: null,
        otherUsername: null,
        agentPeer: false,
        unreadCount: 1,
        globalRank: 2,
        nonMemberMention: false,
        attachmentId: null,
        conversationKind: "app_events",
        directKey: "app:app-1|agent:agent-1",
        appKey: "github",
      },
    ];
    const db = {
      agent: { findMany: async () => [] },
      $queryRaw: async () => rows,
      ...recoverySecondPassStubs,
    } as unknown as PrismaClient;

    const result = await new PrismaDirectConversationRepository(db).readAgentRecoveryContext(
      "ws-1",
      "agent-1",
    );

    expect(result.unreadSummary).toEqual({
      "@app.system.artifacts": 2,
      "@app.github": 1,
    });
    expect(
      result.resumeMessages.map((m) => ({ target: m.target, sender: m.latestSenderKind })),
    ).toEqual([
      { target: "@app.system.artifacts", sender: "system" },
      { target: "@app.github", sender: "system" },
    ]);
  });

  test("readPendingAgentDeliveries names app_events targets and marks source as app", async () => {
    const db = {
      $queryRaw: async () => [{ deliveryId: "del-sys-1" }],
      agentMessageDelivery: {
        findMany: async () => [
          {
            deliveryId: "del-sys-1",
            messageId: "msg-sys-1",
            conversationId: "conv-sys",
            sequence: 1,
            reason: null,
            conversation: {
              kind: "app_events",
              channelName: null,
              directKey: "system:system.artifacts|agent:agent-1",
              attachmentCommentThread: null,
              members: [{ user: null, agent: { id: "agent-1", name: "scout" } }],
              taskDiscussionOf: null,
            },
            message: {
              body: "CoForge artifacts: new comment",
              createdAt: RECOVERY_CREATED_AT,
              threadRootId: null,
              sender: null,
              mentions: [],
              forwards: [],
              attachments: [],
              pendingMentionActions: [],
              actionCard: null,
            },
          },
        ],
      },
      conversationMember: {
        findMany: async () => [{ conversationId: "conv-sys" }],
      },
      agent: { findMany: async () => [] },
      user: { findMany: async () => [] },
      workspaceMembership: { findMany: async () => [] },
      task: { findMany: async () => [] },
      app: { findMany: async () => [] },
    } as unknown as PrismaClient;

    const pending = await new PrismaDirectConversationRepository(db).readPendingAgentDeliveries(
      "ws-1",
      "agent-1",
    );

    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      target: "@app.system.artifacts",
      source: "app",
      latestSenderKind: "system",
      latestSenderHandle: "",
    });
  });

  test("listWakeHints resolves @app.system.artifacts and @app.<key> targets", async () => {
    const db = {
      $queryRaw: async () => [
        {
          conversationId: "conv-sys",
          threadRootId: null,
          pendingCount: 1,
          firstPendingMsgId: "msg-sys-1",
          latestMsgId: "msg-sys-1",
          latestSeq: 1,
          latestSenderName: null,
          latestSenderType: "system",
          mentioned: false,
          outsideMention: false,
        },
        {
          conversationId: "conv-app",
          threadRootId: null,
          pendingCount: 2,
          firstPendingMsgId: "msg-app-1",
          latestMsgId: "msg-app-2",
          latestSeq: 2,
          latestSenderName: null,
          latestSenderType: "system",
          mentioned: false,
          outsideMention: false,
        },
      ],
      conversation: {
        findMany: async () => [
          {
            id: "conv-sys",
            kind: "app_events",
            channelName: null,
            directKey: "system:system.artifacts|agent:agent-1",
            attachmentCommentThread: null,
            members: [],
            taskDiscussionOf: null,
          },
          {
            id: "conv-app",
            kind: "app_events",
            channelName: null,
            directKey: "app:app-1|agent:agent-1",
            attachmentCommentThread: null,
            members: [],
            taskDiscussionOf: null,
          },
        ],
      },
      user: { findMany: async () => [] },
      workspaceMembership: { findMany: async () => [] },
      agent: { findMany: async () => [] },
      app: { findMany: async () => [{ id: "app-1", key: "github" }] },
    } as unknown as PrismaClient;

    const hints = await listWakeHints(db, { workspaceId: "ws-1", agentId: "agent-1" });
    expect(hints.map((h) => h.target)).toEqual(["@app.system.artifacts", "@app.github"]);
  });

  test("listAgentInbox includes unread @app.system.artifacts and @app.<key> conversations", async () => {
    const latestAt = new Date("2026-11-19T12:00:00.000Z");
    let queryCount = 0;
    const db = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        const sql = strings.join("?");
        queryCount += 1;
        if (sql.includes("app_events")) {
          return [
            {
              conversationId: "conv-sys",
              threadRootId: null,
              channelName: null,
              peer: null,
              peerKind: null,
              directKey: "system:system.artifacts|agent:agent-1",
              appKey: null,
              muted: false,
              readSeq: 0,
              unread: 2,
              mentions: 0,
              latestSeq: 2,
              latestAt,
            },
            {
              conversationId: "conv-app",
              threadRootId: null,
              channelName: null,
              peer: null,
              peerKind: null,
              directKey: "app:app-1|agent:agent-1",
              appKey: "github",
              muted: false,
              readSeq: 1,
              unread: 1,
              mentions: 0,
              latestSeq: 2,
              latestAt: new Date("2026-11-19T11:00:00.000Z"),
            },
          ];
        }
        return [];
      },
      user: { findMany: async () => [] },
      agent: { findMany: async () => [] },
      workspaceMembership: { findMany: async () => [] },
    } as unknown as PrismaClient;

    const inbox = await listAgentInbox(db, "ws-1", "agent-1");
    expect(queryCount).toBeGreaterThanOrEqual(3);
    expect(inbox.items).toEqual([
      {
        kind: "dm",
        target: "@app.system.artifacts",
        unread: 2,
        mentions: 0,
        latestAt: latestAt.toISOString(),
        latestSenderName: null,
        lastReadSeq: 0,
      },
      {
        kind: "dm",
        target: "@app.github",
        unread: 1,
        mentions: 0,
        latestAt: "2026-11-19T11:00:00.000Z",
        latestSenderName: null,
        lastReadSeq: 1,
      },
    ]);
    expect(inbox.totals).toEqual({ conversations: 2, dms: 2, mentions: 0 });
  });
});
