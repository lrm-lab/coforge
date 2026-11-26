import { describe, expect, test } from "bun:test";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import * as agentRosterModule from "#src/server/agents/agent-roster.server";
import { listExtraAgents } from "#src/server/agents/extra-agents.server";
import { actionCardViews } from "#src/server/conversations/action-card-views.server";
import { openChannel } from "#src/server/conversations/channel-page.server";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";
import { listUserSavedMessages } from "#src/server/conversations/saved-messages.server";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const OWNER_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_ID = "00000000-0000-4000-8000-000000000003";
const CHANNEL_ID = "00000000-0000-4000-8000-000000000004";
const MEMBER_ID = "00000000-0000-4000-8000-000000000005";
const COMPUTER_ID = "00000000-0000-4000-8000-000000000006";

const displaySnapshot = (agentId: string): AgentDisplaySnapshot => ({
  protocolMajor: 1,
  workspaceId: WORKSPACE_ID,
  computerId: COMPUTER_ID,
  agentId,
  revision: 1,
  activityKind: "online",
  detailKind: "none",
  detail: "",
  entries: [],
  expiresAt: null,
});

const rawMessage = (id: string, sequence: number, threadRootId: string | null = null) => ({
  id,
  sequence,
  threadRootId,
  senderMemberId: MEMBER_ID,
  body: `msg-${sequence}`,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  attachments: [],
  sender: {
    userId: OWNER_ID,
    agentId: null,
    user: { username: "owner", displayName: "Owner", avatarObjectKey: null },
    agent: null,
  },
  mentions: [],
  reactionVersion: 0,
  reactions: [],
  forwards: [],
  systemMessage: null,
});

describe("web-server read hot paths", () => {
  test("listExtraAgents overlaps busyScopes with agent query", async () => {
    const events: string[] = [];
    const db = {
      agent: {
        findMany: async () => {
          events.push("db:start");
          await Promise.resolve();
          events.push("db:end");
          return [];
        },
      },
    } as unknown as Pick<PrismaClient, "agent">;
    const displays = {
      busyScopes: async () => {
        events.push("redis:start");
        await Promise.resolve();
        events.push("redis:end");
        return [];
      },
      snapshotMany: async () => [],
    };
    await listExtraAgents(db, displays, WORKSPACE_ID, {
      kind: "user",
      userId: OWNER_ID,
      role: "member",
    });
    expect(events.indexOf("redis:start")).toBeGreaterThan(-1);
    expect(events.indexOf("redis:start")).toBeLessThan(events.indexOf("db:end"));
  });

  test("loadWorkspaceAgentsSnapshot queries agents once, overlaps busyScopes, and batches display snapshots", async () => {
    const snapshotFn = (
      agentRosterModule as unknown as {
        loadWorkspaceAgentsSnapshot?: (
          db: PrismaClient,
          userId: string,
          workspaceId: string,
          viewer: { kind: "user"; userId: string; role: string | undefined } | undefined,
          ports?: {
            statuses?: { snapshotMany: (scopes: readonly unknown[]) => Promise<unknown[]> };
            displays?: {
              busyScopes: (workspaceId: string, now: number) => Promise<unknown[]>;
              snapshotMany: (scopes: readonly unknown[]) => Promise<AgentDisplaySnapshot[]>;
            };
          },
        ) => Promise<{
          agents: Array<{ id: string; display?: AgentDisplaySnapshot }>;
          extraAgents: Array<{ id: string; display?: AgentDisplaySnapshot }> | undefined;
          statusAgents: Array<{ id: string; computerId: string | null }>;
        }>;
      }
    ).loadWorkspaceAgentsSnapshot;
    expect(typeof snapshotFn).toBe("function");

    const events: string[] = [];
    let agentQueryCount = 0;
    const displayBatchCalls: number[] = [];
    const db = {
      agent: {
        findMany: async () => {
          agentQueryCount += 1;
          events.push("agents:start");
          await Promise.resolve();
          events.push("agents:end");
          return [
            {
              id: "agent-owned",
              workspaceId: WORKSPACE_ID,
              name: "owned",
              displayName: "Owned",
              description: "",
              createdAt: new Date("2026-01-01T00:00:00Z"),
              ownerId: OWNER_ID,
              computerId: COMPUTER_ID,
              hosting: "managed",
              runtimeConfig: null,
              runtimeConfigRevision: 0,
              stoppedAt: null,
              deletedAt: null,
              visibility: "private",
              avatarMascot: null,
              systemKind: null,
            },
            {
              id: "agent-extra-b",
              workspaceId: WORKSPACE_ID,
              name: "extra-b",
              displayName: "Extra B",
              description: "",
              createdAt: new Date("2026-01-02T00:00:00Z"),
              ownerId: OTHER_ID,
              computerId: COMPUTER_ID,
              hosting: "managed",
              runtimeConfig: null,
              runtimeConfigRevision: 0,
              stoppedAt: null,
              deletedAt: null,
              visibility: "public",
              avatarMascot: null,
              systemKind: null,
            },
            {
              id: "agent-extra-a",
              workspaceId: WORKSPACE_ID,
              name: "extra-a",
              displayName: "Extra A",
              description: "",
              createdAt: new Date("2026-01-03T00:00:00Z"),
              ownerId: OTHER_ID,
              computerId: COMPUTER_ID,
              hosting: "managed",
              runtimeConfig: null,
              runtimeConfigRevision: 0,
              stoppedAt: null,
              deletedAt: null,
              visibility: "public",
              avatarMascot: null,
              systemKind: null,
            },
            {
              id: "agent-hidden-private",
              workspaceId: WORKSPACE_ID,
              name: "secret",
              displayName: "Secret",
              description: "",
              createdAt: new Date("2026-01-04T00:00:00Z"),
              ownerId: OTHER_ID,
              computerId: COMPUTER_ID,
              hosting: "managed",
              runtimeConfig: null,
              runtimeConfigRevision: 0,
              stoppedAt: null,
              deletedAt: null,
              visibility: "private",
              avatarMascot: null,
              systemKind: null,
            },
          ];
        },
      },
      appInstallationBot: {
        findMany: async () => [],
      },
    } as unknown as PrismaClient;

    const result = await snapshotFn!(
      db,
      OWNER_ID,
      WORKSPACE_ID,
      { kind: "user", userId: OWNER_ID, role: "member" },
      {
        statuses: { snapshotMany: async (scopes) => scopes.map(() => undefined) },
        displays: {
          busyScopes: async () => {
            events.push("busy:start");
            await Promise.resolve();
            events.push("busy:end");
            return [];
          },
          snapshotMany: async (scopes) => {
            displayBatchCalls.push(scopes.length);
            return (scopes as Array<{ agentId: string }>).map((scope) =>
              displaySnapshot(scope.agentId),
            );
          },
        },
      },
    );

    expect(agentQueryCount).toBe(1);
    expect(events.indexOf("busy:start")).toBeGreaterThan(-1);
    expect(events.indexOf("busy:start")).toBeLessThan(events.indexOf("agents:end"));
    expect(displayBatchCalls).toEqual([3]);
    expect(result.agents.map((a) => a.id)).toEqual(["agent-owned"]);
    expect(result.extraAgents?.map((a) => a.id)).toEqual(["agent-extra-a", "agent-extra-b"]);
    expect(result.statusAgents.map((a) => a.id)).toEqual([
      "agent-owned",
      "agent-extra-b",
      "agent-extra-a",
      "agent-hidden-private",
    ]);
  });

  test("actionCardViews avoids nested preparedByAgent select and scopes directly when authorizedConversationId is provided", async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    const db = {
      actionCard: {
        findMany: async (args: Record<string, unknown>) => {
          capturedArgs = args;
          return [];
        },
      },
    } as unknown as PrismaClient;

    await (
      actionCardViews as (
        db: PrismaClient,
        workspaceId: string,
        viewerUserId: string,
        messageIds: string[],
        options?: { authorizedConversationId?: string },
      ) => Promise<Map<string, unknown>>
    )(db, WORKSPACE_ID, OWNER_ID, ["msg-1"], { authorizedConversationId: CHANNEL_ID });

    expect(capturedArgs?.where).toEqual({
      workspaceId: WORKSPACE_ID,
      conversationId: CHANNEL_ID,
      messageId: { in: ["msg-1"] },
    });
    const select = capturedArgs?.select as Record<string, unknown>;
    expect(select.preparedByAgentId).toBe(true);
    expect(select.preparedByAgent).toBeUndefined();
  });

  test("openChannel with includeViewerViews overlaps actionCardViews with readWindowThreads", async () => {
    const events: string[] = [];
    const db = {
      workspaceMembership: { findUnique: async () => ({ role: "member" }) },
      conversation: {
        findFirst: async () => ({
          id: CHANNEL_ID,
          channelName: "general",
          description: null,
          archivedAt: null,
          visibility: "public",
          coordinatorAgent: null,
        }),
      },
      conversationMember: {
        findUnique: async () => ({
          id: MEMBER_ID,
          leftAt: null,
          notificationLevel: "all",
          collapseLongMessages: false,
          user: { username: "owner" },
          pins: [],
        }),
        findMany: async () => [],
      },
      message: {
        findMany: async () => [rawMessage("msg-1", 1)],
      },
      messageMention: { findMany: async () => [] },
      $queryRaw: async (query: TemplateStringsArray) => {
        if (!query.join("").includes("thread_reads")) return [];
        events.push("threads:start");
        await Promise.resolve();
        events.push("threads:end");
        return [];
      },
      threadRead: { findMany: async () => [] },
      threadFollow: { findMany: async () => [] },
      actionCard: {
        findMany: async () => {
          events.push("cards:start");
          await Promise.resolve();
          events.push("cards:end");
          return [];
        },
      },
    } as unknown as PrismaClient;

    await openChannel(
      { db, inboxPurge: { purge: async () => {} } },
      WORKSPACE_ID,
      OWNER_ID,
      CHANNEL_ID,
      { includeViewerViews: true } as never,
    );

    expect(events.indexOf("cards:start")).toBeGreaterThan(-1);
    expect(events.indexOf("cards:start")).toBeLessThan(events.indexOf("threads:end"));
  });

  test("ConversationHistory.loadAround fetches ids first and hydrates before+after in a single query", async () => {
    const findManyCalls: Array<Record<string, unknown>> = [];
    const db = {
      workspaceMembership: { findUnique: async () => ({ userId: OWNER_ID }) },
      conversation: {
        findFirst: async () => ({
          directKey: null,
          channelName: "general",
          visibility: "public",
          members: [{ id: MEMBER_ID, leftAt: null }],
        }),
      },
      $queryRaw: async () => [],
      threadRead: { findMany: async () => [] },
      threadFollow: { findMany: async () => [] },
      message: {
        findFirst: async () => ({ id: "msg-2", sequence: 2, threadRoot: null }),
        findMany: async (args: Record<string, unknown>) => {
          findManyCalls.push(args);
          const select = args.select as Record<string, unknown>;
          if (Object.keys(select).length === 1 && select.id === true) {
            const orderBy = args.orderBy as { sequence: string };
            return orderBy.sequence === "desc" ? [{ id: "msg-2" }, { id: "msg-1" }] : [];
          }
          return [rawMessage("msg-1", 1), rawMessage("msg-2", 2)];
        },
      },
    } as unknown as PrismaClient;

    const page = await new ConversationHistory(db).loadAround(
      WORKSPACE_ID,
      OWNER_ID,
      CHANNEL_ID,
      "msg-2",
      41,
    );

    expect(page.messages.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
    const idOnlyCalls = findManyCalls.filter(
      (call) => Object.keys(call.select as Record<string, unknown>).join(",") === "id",
    );
    const hydrateCalls = findManyCalls.filter(
      (call) => Object.keys(call.select as Record<string, unknown>).length > 1,
    );
    expect(idOnlyCalls).toHaveLength(2);
    expect(hydrateCalls).toHaveLength(1);
  });

  test("ConversationHistory.loadThread skips full message hydration when thread has zero replies", async () => {
    const findManyCalls: Array<Record<string, unknown>> = [];
    const db = {
      workspaceMembership: { findUnique: async () => ({ userId: OWNER_ID }) },
      conversation: {
        findFirst: async () => ({
          directKey: null,
          channelName: "general",
          visibility: "public",
          members: [{ id: MEMBER_ID, leftAt: null }],
        }),
      },
      message: {
        findFirst: async () => ({ id: "root-1" }),
        findMany: async (args: Record<string, unknown>) => {
          findManyCalls.push(args);
          return [];
        },
      },
    } as unknown as PrismaClient;

    const result = await new ConversationHistory(db).loadThread(
      WORKSPACE_ID,
      OWNER_ID,
      CHANNEL_ID,
      "root-1",
    );

    expect(result.replies).toEqual([]);
    expect(findManyCalls).toHaveLength(1);
    expect(findManyCalls[0]?.select).toEqual({ id: true });
  });

  test("listUserSavedMessages uses scalar key lookup first and skips nested hydration when empty", async () => {
    const findManyCalls: Array<Record<string, unknown>> = [];
    const db = {
      savedMessage: {
        findMany: async (args: Record<string, unknown>) => {
          findManyCalls.push(args);
          return [];
        },
      },
    } as unknown as PrismaClient;

    const saved = await listUserSavedMessages(db, {
      workspaceId: WORKSPACE_ID,
      userId: OWNER_ID,
    });

    expect(saved).toEqual([]);
    expect(findManyCalls).toHaveLength(1);
    expect(findManyCalls[0]?.select).toEqual({ messageId: true, memberId: true });
  });
});
