import { describe, expect, test } from "bun:test";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import type { DirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { quietCentrifugo, withPublishBatch } from "./helpers/fake-centrifugo";
import { MemoryMessageRequestIdempotency } from "./helpers/memory-message-request-idempotency";
import { unusedDatabase } from "./helpers/unused-database";

const persisted = {
  id: "message-a",
  deliveryId: "delivery-a",
  body: "Hello Agent",
  createdAt: new Date("2026-08-28T00:00:00Z"),
  workspaceId: "workspace-a",
  computerId: "computer-a",
  agentId: "agent-a",
  sequence: 1,
  threadRootId: null,
  target: "@agent",
  latestSenderKind: "human" as const,
  latestSenderHandle: "ada",
  latestSenderDescription: "",
  attachments: [],
};

describe("SendDirectMessage request idempotency", () => {
  test("same sender scope and idempotencyKey persists once and returns the same message", async () => {
    let persistenceCalls = 0;
    let notificationCalls = 0;
    const repository = {
      async getOrCreateUserAgent() {
        return { id: "conversation-a" };
      },
      async sendMessage() {
        persistenceCalls += 1;
        return persisted;
      },
      database: unusedDatabase,
    } satisfies DirectConversationRepository;
    const useCase = new SendDirectMessage(
      repository,
      new MemoryMessageRequestIdempotency(),
      quietCentrifugo(),
      {
        async memberChanged() {},
        async messageAvailable() {
          notificationCalls += 1;
        },
      },
    );
    const input = {
      idempotencyKey: "request-a",
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      senderMemberId: "member-a",
      senderUserId: "user-a",
      body: "Hello Agent",
    };

    const first = await useCase.execute(input);
    const retry = await useCase.execute(input);

    expect(persistenceCalls).toBe(1);
    expect(notificationCalls).toBe(2);
    expect(retry).toEqual(first);
    expect(retry.createdAt).toBeInstanceOf(Date);
  });

  test("publish failure retry republishes the same persisted delivery", async () => {
    let persistenceCalls = 0;
    let publicationCalls = 0;
    const deliveries: string[] = [];
    const repository = {
      async getOrCreateUserAgent() {
        return { id: "conversation-a" };
      },
      async sendMessage() {
        persistenceCalls += 1;
        return persisted;
      },
      database: unusedDatabase,
    } satisfies DirectConversationRepository;
    const useCase = new SendDirectMessage(
      repository,
      new MemoryMessageRequestIdempotency(),
      withPublishBatch({
        async publish(_channel, data) {
          publicationCalls += 1;
          deliveries.push(decodeAgentMessageDelivery(data).deliveryId);
          if (publicationCalls === 1) throw new Error("publication failed");
        },
      }),
    );
    const input = {
      idempotencyKey: "request-a",
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      senderMemberId: "member-a",
      senderUserId: "user-a",
      body: "Hello Agent",
    };

    await expect(useCase.execute(input)).rejects.toThrow("publication failed");
    await expect(useCase.execute(input)).resolves.toMatchObject({
      id: "message-a",
    });

    expect(persistenceCalls).toBe(1);
    expect(deliveries).toEqual(["delivery-a", "delivery-a"]);
  });

  test("different requestIds persist distinct messages", async () => {
    let persistenceCalls = 0;
    const repository = {
      async getOrCreateUserAgent() {
        return { id: "conversation-a" };
      },
      async sendMessage() {
        persistenceCalls += 1;
        return { ...persisted, id: `message-${persistenceCalls}` };
      },
      database: unusedDatabase,
    } satisfies DirectConversationRepository;
    const useCase = new SendDirectMessage(
      repository,
      new MemoryMessageRequestIdempotency(),
      quietCentrifugo(),
    );
    const input = {
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      senderMemberId: "member-a",
      senderUserId: "user-a",
      body: "Hello Agent",
    };

    const first = await useCase.execute({ ...input, idempotencyKey: "request-a" });
    const second = await useCase.execute({ ...input, idempotencyKey: "request-b" });

    expect(persistenceCalls).toBe(2);
    expect(second.id).not.toBe(first.id);
  });

  test("User and Agent request scopes do not collide", async () => {
    let userPersistenceCalls = 0;
    let agentPersistenceCalls = 0;
    const repository = {
      async sendMessage() {
        userPersistenceCalls += 1;
        return persisted;
      },
      async userIdForUsername() {
        return "user-a";
      },
      async openAgentDirect(workspaceId: string, agentId: string, parentTarget: string) {
        const userId = await this.userIdForUsername?.(parentTarget);
        if (!userId) throw new Error("target user not found");
        const conversation = await this.getOrCreateUserAgent(workspaceId, userId, agentId);
        return { conversation, peer: { kind: "user" as const, userId } };
      },
      async getOrCreateUserAgent() {
        return { id: "conversation-a" };
      },
      async sendAgentMessage() {
        agentPersistenceCalls += 1;
        return {
          ...persisted,
          id: "agent-message",
          deliveryId: undefined,
          target: "@user",
        };
      },
      database: unusedDatabase,
    } satisfies DirectConversationRepository;
    const useCase = new SendDirectMessage(
      repository,
      new MemoryMessageRequestIdempotency(),
      quietCentrifugo(),
    );

    await useCase.execute({
      idempotencyKey: "same-request",
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      senderMemberId: "member-a",
      senderUserId: "shared-stable-id",
      body: "User message",
    });
    await useCase.executeFromAgent({
      idempotencyKey: "same-request",
      workspaceId: "workspace-a",
      agentId: "shared-stable-id",
      target: "@user",
      body: "Agent message",
    });

    expect(userPersistenceCalls).toBe(1);
    expect(agentPersistenceCalls).toBe(1);
  });
});
