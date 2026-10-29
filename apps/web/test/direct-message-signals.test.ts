import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import type {
  MessageRequestIdempotency,
  MessageRequestScope,
} from "#src/server/conversations/message-request-idempotency.server";
import type { DirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";

/**
 * What a person's direct-message send tells the browser: the open conversation reconciles from its
 * own channel, and every other tab and device of the sender writes the row from the activity event
 * on their own channel. Split from `direct-message.test.ts` along that seam.
 */

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

class MemoryMessageRequestIdempotency implements MessageRequestIdempotency {
  async execute(_scope: MessageRequestScope, persist: () => Promise<typeof persisted>) {
    return persist();
  }
}

test("signals the sender's own channel with the sender named, so their other tabs and devices refresh the DM row", async () => {
  const published: { channel: string; data: Record<string, unknown> }[] = [];
  const repository = {
    async getOrCreateUserAgent() {
      return { id: "conversation-a" };
    },
    async sendMessage() {
      return persisted;
    },
    // What `announceMessage` reads back to build the row it pushes: the sender, the body, and
    // that this conversation is a direct message.
    database: {
      message: {
        async findUnique() {
          return {
            body: "Hello Agent",
            createdAt: new Date("2026-10-29T09:00:00.000Z"),
            threadRootId: null,
            workspaceId: "workspace-a",
            conversation: { channelName: null },
            sender: {
              userId: "user-a",
              agentId: null,
              user: { displayName: "Ada", username: "ada" },
              agent: null,
            },
            mentions: [],
          };
        },
      },
    } as unknown as PrismaClient,
  } satisfies DirectConversationRepository;
  const useCase = new SendDirectMessage(
    repository,
    new MemoryMessageRequestIdempotency(),
    { async publish() {} },
    new CentrifugoConversationRealtime({
      publishJson: async (channel: string, data: Record<string, unknown>) => {
        published.push({ channel, data });
      },
      broadcast: async (channels: string[], data: Record<string, unknown>) => {
        for (const channel of channels) published.push({ channel, data });
      },
    } as unknown as CentrifugoServerApi),
  );

  await useCase.execute({
    idempotencyKey: "request-a",
    workspaceId: "workspace-a",
    conversationId: "conversation-a",
    senderMemberId: "member-a",
    senderUserId: "user-a",
    body: "Hello Agent",
  });
  // The open conversation reconciles from its own channel; the sender's other tabs learn the new
  // row from `conversation.activity.v1` on their own channel, which names the sender.
  expect(published.map((publication) => publication.channel).sort()).toEqual([
    "chat:conversation-a",
    "chat:user:user-a",
  ]);
  expect(
    published.find((publication) => publication.channel === "chat:conversation-a")?.data,
  ).toMatchObject({ type: "message.available.v1", conversationId: "conversation-a" });
  expect(
    published.find((publication) => publication.channel === "chat:user:user-a")?.data,
  ).toMatchObject({
    type: "conversation.activity.v1",
    conversationId: "conversation-a",
    kind: "direct",
    preview: "Hello Agent",
    senderUserId: "user-a",
  });
});
