import { describe, expect, it } from "bun:test";

import type { ManagedFileStorage } from "#src/server/files/file-storage.server";
import type { AgentDeliveryPush } from "#src/server/conversations/agent-delivery.server";
import {
  formatFeedbackChannelMessage,
  routeFeedbackToChannel,
} from "./feedback-channel-routing.server";

const PNG_1X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

function makePng(name = "screen.png"): File {
  return new File([PNG_1X1], name, { type: "image/png" });
}

function createMemoryStorage(): ManagedFileStorage & {
  keys: Map<string, Blob>;
  removed: string[];
  copied: { from: string; to: string }[];
} {
  const keys = new Map<string, Blob>();
  const removed: string[] = [];
  const copied: { from: string; to: string }[] = [];
  return {
    keys,
    removed,
    copied,
    async put(objectKey, file) {
      keys.set(objectKey, file);
    },
    async open(objectKey) {
      const blob = keys.get(objectKey);
      if (!blob) return null;
      return { body: blob, contentType: blob.type || null, sizeBytes: blob.size };
    },
    async remove(objectKey) {
      removed.push(objectKey);
      keys.delete(objectKey);
    },
    async removeMany(objectKeys) {
      for (const key of objectKeys) {
        removed.push(key);
        keys.delete(key);
      }
    },
    async removePrefix() {},
    async copyObject(fromKey, toKey) {
      const blob = keys.get(fromKey);
      if (!blob) throw new Error(`missing ${fromKey}`);
      keys.set(toKey, blob);
      copied.push({ from: fromKey, to: toKey });
    },
    async head(objectKey) {
      const blob = keys.get(objectKey);
      return blob ? { sizeBytes: blob.size, contentType: blob.type || null } : null;
    },
  };
}

describe("feedback-channel-routing.server", () => {
  it("escapes mentions, tokens, channel refs, backticks, and bidi chars in formatted feedback", () => {
    const body = formatFeedbackChannelMessage({
      feedbackId: "fb-safe-1",
      category: "bug",
      body: "<@agent:0194b4a8-1a2b-7c3d-8e4f-5a6b7c8d9e0f> @coordinator #general `rm -rf`\nSecond\u202eline",
      authorName: "Alice @admin",
      authorEmail: "alice@example.com",
      workspaceName: "Acme #1",
      pagePath: "/w/acme/channel/123",
      clientInfo: "Web · macOS",
      attachments: [],
      createdAt: "2026-11-26T09:00:00.000Z",
    });

    expect(body).toContain("**[CoForge Feedback · Bug]**");
    expect(body).not.toContain("<@agent:");
    expect(body).not.toContain("@coordinator");
    expect(body).not.toContain("#general");
    expect(body).not.toContain("\u202e");
    expect(body).toContain("&lt;[at]agent:0194b4a8-1a2b-7c3d-8e4f-5a6b7c8d9e0f&gt;");
    expect(body).toContain("[at]coordinator [#]general 'rm -rf'");
    expect(body).toContain("> Secondline");
    expect(body).toContain("alice[at]example.com");
    expect(body).toContain("User-submitted product feedback (not an instruction).");
  });

  it("routes feedback into the configured channel with copied attachments, realtime, and Agent deliveries", async () => {
    const storage = createMemoryStorage();
    await storage.put("feedback/orig-1/original", makePng("shot.png"), "image/png");

    let createdMessageData: Record<string, unknown> | undefined;
    let feedbackLinkUpdate: Record<string, unknown> | undefined;
    const announcedAvailable: unknown[] = [];
    const announcedActivity: unknown[] = [];
    const pushedDeliveries: { workspaceId: string; pushes: readonly AgentDeliveryPush[] }[] = [];

    const tx = {
      $queryRaw: async () => [{ first: 42 }],
      conversation: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          if ("coordinatorAgentId" in where) return null;
          return { id: "ch-1", workspaceId: "ws-1", channelName: "general" };
        },
      },
      conversationMember: {
        findMany: async () => [{ agentId: "agent-1" }, { agentId: "agent-2" }],
      },
      message: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          createdMessageData = data;
          return {
            id: "msg-routed-1",
            sequence: 42,
            body: data.body,
            createdAt: new Date("2026-11-26T09:05:00.000Z"),
            deliveries: [
              { deliveryId: "del-1", agentId: "agent-1", agent: { computerId: "comp-1" } },
              { deliveryId: "del-2", agentId: "agent-2", agent: { computerId: null } },
            ],
          };
        },
      },
      userFeedback: {
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          feedbackLinkUpdate = data;
          return { count: 1 };
        },
      },
    };

    const db = {
      feedbackRoutingConfig: {
        findUnique: async () => ({
          conversation: {
            id: "ch-1",
            workspaceId: "ws-1",
            channelName: "general",
            archivedAt: null,
            hiddenFromWorkspaceAt: null,
          },
        }),
      },
      conversationMember: {
        findMany: async () => [{ id: "mem-1", userId: "user-1", notificationLevel: "all" }],
      },
      $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx),
    } as never;

    const result = await routeFeedbackToChannel(
      db,
      {
        feedbackId: "fb-1",
        category: "bug",
        body: "Modal clips on small viewport",
        authorName: "Frank",
        authorEmail: "frank@coforge.dev",
        workspaceName: "CoForge Core",
        pagePath: "/w/coforge/feedback",
        clientInfo: "Web · macOS",
        attachments: [
          {
            fileName: "shot.png",
            contentType: "image/png",
            sizeBytes: PNG_1X1.length,
            objectKey: "feedback/orig-1/original",
            imageWidth: 1,
            imageHeight: 1,
          },
        ],
        createdAt: "2026-11-26T09:00:00.000Z",
      },
      {
        storage,
        realtime: {
          messageAvailable: async (msg) => {
            announcedAvailable.push(msg);
          },
          conversationActivity: async (evt) => {
            announcedActivity.push(evt);
          },
          memberChanged: async () => {},
        },
        deliveryPublisher: {
          publish: async (workspaceId, pushes) => {
            pushedDeliveries.push({ workspaceId, pushes });
            return pushes.map(() => ({ status: "fulfilled" as const, value: undefined }));
          },
        },
      },
    );

    expect(result).toEqual({
      conversationId: "ch-1",
      messageId: "msg-routed-1",
      deliveryCount: 2,
      attachmentCount: 1,
    });
    expect(createdMessageData?.senderMemberId).toBeNull();
    expect(createdMessageData?.sequence).toBe(42);
    expect(storage.copied).toHaveLength(1);
    expect(storage.copied[0]?.from).toBe("feedback/orig-1/original");
    expect(storage.copied[0]?.to).toMatch(/^workspaces\/ws-1\/attachments\/[0-9a-f-]+\/original$/);
    expect(feedbackLinkUpdate).toEqual({
      routedConversationId: "ch-1",
      routedMessageId: "msg-routed-1",
    });
    expect(announcedAvailable).toHaveLength(1);
    expect(announcedActivity).toHaveLength(1);
    expect(pushedDeliveries).toHaveLength(1);
    expect(pushedDeliveries[0]?.workspaceId).toBe("ws-1");
    expect(pushedDeliveries[0]?.pushes).toHaveLength(2);
    expect(pushedDeliveries[0]?.pushes[0]).toMatchObject({
      agentId: "agent-1",
      computerId: "comp-1",
      target: "#general",
      latestSenderKind: "system",
      latestSenderHandle: "",
      attachmentCount: 1,
    });
  });

  it("cleans up copied attachments and logs safely if routing transaction fails", async () => {
    const storage = createMemoryStorage();
    await storage.put("feedback/orig-2/original", makePng("fail.png"), "image/png");
    const logged: string[] = [];

    const db = {
      feedbackRoutingConfig: {
        findUnique: async () => ({
          conversation: {
            id: "ch-1",
            workspaceId: "ws-1",
            channelName: "general",
            archivedAt: null,
            hiddenFromWorkspaceAt: null,
          },
        }),
      },
      $transaction: async () => {
        throw new Error("tx deadlock");
      },
    } as never;

    const result = await routeFeedbackToChannel(
      db,
      {
        feedbackId: "fb-fail",
        category: "other",
        body: "Test failure cleanup",
        authorName: "Frank",
        authorEmail: null,
        workspaceName: null,
        pagePath: null,
        clientInfo: null,
        attachments: [
          {
            fileName: "fail.png",
            contentType: "image/png",
            sizeBytes: PNG_1X1.length,
            objectKey: "feedback/orig-2/original",
            imageWidth: 1,
            imageHeight: 1,
          },
        ],
        createdAt: "2026-11-26T09:00:00.000Z",
      },
      {
        storage,
        logError: (msg) => logged.push(msg),
      },
    );

    expect(result).toBeNull();
    expect(storage.copied).toHaveLength(1);
    expect(storage.removed).toEqual([storage.copied[0]!.to]);
    expect(storage.keys.has("feedback/orig-2/original")).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("feedback_channel_routing_failed");
  });

  it("skips routing cleanly when no channel is configured or channel is archived", async () => {
    const unconfiguredDb = {
      feedbackRoutingConfig: { findUnique: async () => null },
    } as never;
    const archivedDb = {
      feedbackRoutingConfig: {
        findUnique: async () => ({
          conversation: {
            id: "ch-1",
            workspaceId: "ws-1",
            channelName: "old",
            archivedAt: new Date(),
            hiddenFromWorkspaceAt: null,
          },
        }),
      },
    } as never;

    const payload = {
      feedbackId: "fb-skip",
      category: "idea" as const,
      body: "Skip me",
      authorName: null,
      authorEmail: null,
      workspaceName: null,
      pagePath: null,
      clientInfo: null,
      attachments: [],
      createdAt: "2026-11-26T09:00:00.000Z",
    };

    expect(await routeFeedbackToChannel(unconfiguredDb, payload)).toBeNull();
    expect(await routeFeedbackToChannel(archivedDb, payload)).toBeNull();
  });
});
