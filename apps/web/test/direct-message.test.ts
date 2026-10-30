import { describe, expect, test } from "bun:test";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import type { DirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { bestEffortMessageNotifier } from "#src/server/notifications/web-push-composition.server";
import { quietCentrifugo, withPublishBatch } from "./helpers/fake-centrifugo";
import { MemoryMessageRequestIdempotency } from "./helpers/memory-message-request-idempotency";

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

/** The use case over a test repository, with request records kept in memory. */
const sendDirectMessage = (
  repository: DirectConversationRepository,
  ...rest: ConstructorParameters<typeof SendDirectMessage> extends [unknown, unknown, ...infer R]
    ? R
    : never
) => new SendDirectMessage(repository, new MemoryMessageRequestIdempotency(), ...rest);

describe("SendDirectMessage", () => {
  test("publishes the full thread target while keeping the sender unchanged", async () => {
    let publication: Uint8Array | undefined;
    const repository = {
      getOrCreateUserAgent: async () => ({ id: "conversation-a" }),
      sendMessage: async (...args: Parameters<DirectConversationRepository["sendMessage"]>) => {
        expect(args[5]).toBe("12345678-0000-4000-8000-000000000001");
        return { ...persisted, deliveryTarget: "@ada:12345678" };
      },
    } satisfies DirectConversationRepository;
    await sendDirectMessage(
      repository,
      withPublishBatch({
        publish: async (_channel, data) => {
          publication = data;
        },
      }),
    ).execute({
      idempotencyKey: "thread-request",
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      senderMemberId: "member-a",
      senderUserId: "user-a",
      body: "reply",
      threadRootId: "12345678-0000-4000-8000-000000000001",
    });
    expect(decodeAgentMessageDelivery(publication!)).toMatchObject({
      target: "@ada:12345678",
      latestSenderKind: "human",
      latestSenderHandle: "ada",
    });
  });

  test("forwards multiple attachmentIds from a human send to the repository, in order", async () => {
    const calls: unknown[] = [];
    const attachmentIds = ["attachment-b", "attachment-a"];
    const repository = {
      async getOrCreateUserAgent() {
        return { id: "conversation-a" };
      },
      async sendMessage(
        conversationId: string,
        senderMemberId: string,
        senderUserId: string,
        body: string,
        attachmentIdsArg?: string[],
      ) {
        calls.push({ conversationId, senderMemberId, senderUserId, body, attachmentIdsArg });
        return {
          ...persisted,
          attachments: (attachmentIdsArg ?? []).map((id) => ({
            id,
            fileName: `${id}.txt`,
            contentType: "text/plain",
            sizeBytes: 1,
          })),
        };
      },
    } satisfies DirectConversationRepository;
    const useCase = sendDirectMessage(repository, quietCentrifugo());

    const result = await useCase.execute({
      idempotencyKey: "multi-attachment-request",
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      senderMemberId: "member-a",
      senderUserId: "user-a",
      body: "two files",
      attachmentIds,
    });

    expect(calls).toEqual([
      {
        conversationId: "conversation-a",
        senderMemberId: "member-a",
        senderUserId: "user-a",
        body: "two files",
        attachmentIdsArg: attachmentIds,
      },
    ]);
    // Order matches send order, not upload order or any other reordering.
    expect(result.attachments.map((a) => a.id)).toEqual(["attachment-b", "attachment-a"]);
  });

  test("persists before publishing the canonical message to its Workspace", async () => {
    const calls: string[] = [];
    let publication: { channel: string; data: Uint8Array } | undefined;
    const repository = {
      async getOrCreateUserAgent() {
        return { id: "conversation-a" };
      },
      async sendMessage() {
        calls.push("persist");
        return persisted;
      },
    } satisfies DirectConversationRepository;
    const useCase = sendDirectMessage(
      repository,
      withPublishBatch({
        async publish(channel, data) {
          calls.push("publish");
          publication = { channel, data };
        },
      }),
    );

    await useCase.execute({
      idempotencyKey: "request-a",
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      senderMemberId: "member-a",
      senderUserId: "user-a",
      body: "Hello Agent",
    });

    expect(calls).toEqual(["persist", "publish"]);
    expect(publication?.channel).toBe("daemon:workspace-a:computer-a");
    expect(decodeAgentMessageDelivery(publication!.data)).toEqual({
      protocolMajor: 1,
      requestId: "request-a",
      createdAtMs: persisted.createdAt.getTime(),
      messageId: "message-a",
      deliveryId: "delivery-a",
      sequence: 1,
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      agentId: "agent-a",
      body: "Hello Agent",
      method: "agent:v1:message:deliver",
      target: "@ada",
      latestSenderKind: "human",
      latestSenderHandle: "ada",
      latestSenderDescription: "",
    });
    expect(JSON.stringify(decodeAgentMessageDelivery(publication!.data))).not.toContain("user-a");
  });

  test("signals browsers after a human message persists and tolerates signal failure", async () => {
    const calls: string[] = [];
    const repository = {
      async getOrCreateUserAgent() {
        return { id: "conversation-a" };
      },
      async sendMessage() {
        calls.push("persist");
        return persisted;
      },
    } satisfies DirectConversationRepository;
    const useCase = sendDirectMessage(
      repository,
      withPublishBatch({
        async publish() {
          calls.push("daemon");
        },
      }),
      {
        async memberChanged() {},
        async messageAvailable(input) {
          calls.push(`browser:${input.conversationId}:${input.messageId}:${input.sequence}`);
          throw new Error("controlled browser publication outage");
        },
      },
    );

    await expect(
      useCase.execute({
        idempotencyKey: "request-a",
        workspaceId: "workspace-a",
        conversationId: "conversation-a",
        senderMemberId: "member-a",
        senderUserId: "user-a",
        body: "Hello Agent",
      }),
    ).resolves.toEqual(persisted);
    expect(calls).toEqual(["persist", "browser:conversation-a:message-a:1", "daemon"]);
  });

  test("signals a human message with its idempotency key, so the sender's browser can match it", async () => {
    const signals: unknown[] = [];
    const repository = {
      async getOrCreateUserAgent() {
        return { id: "conversation-a" };
      },
      async sendMessage() {
        return persisted;
      },
    } satisfies DirectConversationRepository;
    const useCase = sendDirectMessage(repository, quietCentrifugo(), {
      async memberChanged() {},
      async messageAvailable(input) {
        signals.push(input);
      },
    });

    await useCase.execute({
      idempotencyKey: "request-a",
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      senderMemberId: "member-a",
      senderUserId: "user-a",
      body: "Hello Agent",
    });
    expect(signals).toEqual([
      expect.objectContaining({ messageId: "message-a", idempotencyKey: "request-a" }),
    ]);
  });

  test.each([
    // No sender kind resolved at all.
    { latestSenderKind: undefined, latestSenderHandle: undefined },
    // An Agent kind on this human-send path (never expected, so treated as unresolved).
    { latestSenderKind: "agent" as const, latestSenderHandle: "ada" },
    // An internal id in place of a public handle must never publish.
    {
      latestSenderKind: "human" as const,
      latestSenderHandle: "2c9d2c18-2a0b-4a95-9e5a-111111111111",
    },
  ])(
    "does not publish without a valid public sender target: %j",
    async ({ latestSenderKind, latestSenderHandle }) => {
      let published = false;
      const repository = {
        async getOrCreateUserAgent() {
          return { id: "conversation-a" };
        },
        async sendMessage() {
          return { ...persisted, latestSenderKind, latestSenderHandle };
        },
      } satisfies DirectConversationRepository;
      const useCase = sendDirectMessage(
        repository,
        withPublishBatch({
          async publish() {
            published = true;
          },
        }),
      );

      await expect(
        useCase.execute({
          idempotencyKey: "request-a",
          workspaceId: "workspace-a",
          conversationId: "conversation-a",
          senderMemberId: "member-a",
          senderUserId: "user-a",
          body: "Hello Agent",
        }),
      ).rejects.toThrow("message sender must be a public @username");
      expect(published).toBe(false);
    },
  );

  test.each(["sender is not a conversation member", "conversation scope is not authorized"])(
    "does not publish when persistence rejects: %s",
    async (reason) => {
      let published = false;
      const repository = {
        async getOrCreateUserAgent() {
          return { id: "conversation-a" };
        },
        async sendMessage() {
          throw new Error(reason);
        },
      } satisfies DirectConversationRepository;
      const useCase = sendDirectMessage(
        repository,
        withPublishBatch({
          async publish() {
            published = true;
          },
        }),
      );
      await expect(
        useCase.execute({
          idempotencyKey: "request-a",
          workspaceId: "workspace-a",
          conversationId: "conversation-a",
          senderMemberId: "member-a",
          senderUserId: "user-a",
          body: "Hello Agent",
        }),
      ).rejects.toThrow(reason);
      expect(published).toBe(false);
    },
  );

  test("publishes an Agent reply to the browser conversation after persistence", async () => {
    const calls: string[] = [];
    let publication: { channel: string; data: unknown; idempotencyKey?: string } | undefined;
    const repository = {
      async sendMessage() {
        throw new Error("not used");
      },
      async userIdForUsername() {
        return "internal-user";
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
        calls.push("persist");
        return { ...persisted, deliveryId: undefined, target: "@user" };
      },
    } satisfies DirectConversationRepository;
    const useCase = sendDirectMessage(
      repository,
      withPublishBatch({
        async publish() {
          throw new Error("must not publish an Agent reply to a Daemon channel");
        },
      }),
      {
        async memberChanged() {},
        async messageAvailable({ conversationId, messageId, sequence }) {
          calls.push("publish");
          publication = {
            channel: `chat:${conversationId}`,
            data: {
              type: "message.available.v1",
              conversationId,
              messageId,
              sequence,
            },
            idempotencyKey: messageId,
          };
        },
      },
    );

    await useCase.executeFromAgent({
      idempotencyKey: "request-a",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      target: "@user",
      body: "Hi",
    });
    expect(calls).toEqual(["persist", "publish"]);
    expect(publication).toEqual({
      channel: "chat:conversation-a",
      data: {
        type: "message.available.v1",
        conversationId: "conversation-a",
        messageId: "message-a",
        sequence: 1,
      },
      idempotencyKey: "message-a",
    });
  });

  test("resolves an Agent send promptly even when Web Push delivery never settles", async () => {
    const repository = {
      async sendMessage() {
        throw new Error("not used");
      },
      async userIdForUsername() {
        return "internal-user";
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
        return { ...persisted, deliveryId: undefined, target: "@user" };
      },
    } satisfies DirectConversationRepository;
    const useCase = sendDirectMessage(
      repository,
      quietCentrifugo(),
      { async messageAvailable() {}, async memberChanged() {} },
      bestEffortMessageNotifier({} as PrismaClient, async () => ({
        notifyMessage: () => new Promise(() => {}),
      })),
    );

    await expect(
      useCase.executeFromAgent({
        idempotencyKey: "request-a",
        workspaceId: "workspace-a",
        agentId: "agent-a",
        target: "@user",
        body: "Hi",
      }),
    ).resolves.toMatchObject({ id: "message-a" });
  });

  test("routes an Agent channel-thread reply through the parent channel and preserves the root", async () => {
    const rootId = "12345678-0000-4000-8000-000000000001";
    const calls: string[] = [];
    const repository = {
      async sendMessage() {
        throw new Error("not used");
      },
      async getOrCreateUserAgent() {
        throw new Error("not used");
      },
      async getAgentChannel(workspaceId: string, agentId: string, target: string) {
        calls.push(`channel:${workspaceId}:${agentId}:${target}`);
        return { id: "channel-a" };
      },
      async sendAgentMessage(
        conversationId: string,
        agentId: string,
        body: string,
        attachmentIds?: string[],
        threadRootId?: string,
      ) {
        calls.push(
          `send:${conversationId}:${agentId}:${body}:${(attachmentIds ?? []).join(",")}:${threadRootId ?? ""}`,
        );
        return {
          ...persisted,
          deliveryId: undefined,
          target: `#general:${rootId}`,
        };
      },
    } satisfies DirectConversationRepository;
    const useCase = sendDirectMessage(
      repository,
      withPublishBatch({
        async publish() {
          throw new Error("must not publish an Agent reply to a Daemon channel");
        },
      }),
      undefined,
      {
        async notifyMessage(messageId) {
          calls.push(`notify:${messageId}`);
        },
      },
    );

    await expect(
      useCase.executeFromAgent({
        idempotencyKey: "channel-thread-request",
        workspaceId: "workspace-a",
        agentId: "agent-a",
        target: `#general:${rootId}`,
        body: "Thread reply",
      }),
    ).resolves.toMatchObject({ target: `#general:${rootId}` });
    expect(calls).toEqual([
      "channel:workspace-a:agent-a:#general",
      `send:channel-a:agent-a:Thread reply::${rootId}`,
      "notify:message-a",
    ]);
  });

  test("reads an Agent channel send's mention report while its publications run, and answers after both", async () => {
    // The report is released only once the notifier is waiting on it: a send that read the report
    // after its publications would leave the notifier waiting, and the timeout rejects the send.
    let releaseNotifier!: () => void;
    const reportRead = new Promise<void>((resolve) => (releaseNotifier = resolve));
    let notified = false;
    const repository = {
      async sendMessage() {
        throw new Error("not used");
      },
      async getOrCreateUserAgent() {
        throw new Error("not used");
      },
      async getAgentChannel() {
        return { id: "channel-a" };
      },
      async sendAgentMessage() {
        return { ...persisted, deliveryId: undefined, target: "#general" };
      },
      async agentMentionReport() {
        releaseNotifier();
        return { pendingMentionActions: [], unresolvedMentionHandles: ["nobody"] };
      },
    } satisfies DirectConversationRepository;
    const useCase = sendDirectMessage(repository, quietCentrifugo(), undefined, {
      async notifyMessage() {
        await Promise.race([
          reportRead,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("the report waited for the publications")), 500),
          ),
        ]);
        notified = true;
      },
    });

    const sent = await useCase.executeFromAgent({
      idempotencyKey: "channel-request",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      target: "#general",
      body: "Hi @nobody",
    });
    expect(sent).toMatchObject({ id: "message-a", unresolvedMentionHandles: ["nobody"] });
    expect(notified).toBe(true);
  });

  test("forwards attachmentIds and mentions from an Agent send to the repository, in order", async () => {
    const calls: unknown[] = [];
    const mentions = [{ type: "user" as const, id: "actor-1", name: "ada" }];
    const attachmentIds = ["attachment-1", "attachment-2"];
    const repository = {
      async sendMessage() {
        throw new Error("not used");
      },
      async userIdForUsername() {
        return "internal-user";
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
      async sendAgentMessage(
        conversationId: string,
        agentId: string,
        body: string,
        attachmentIdsArg?: string[],
        threadRootId?: string,
        mentionsArg?: unknown,
      ) {
        calls.push({ conversationId, agentId, body, attachmentIdsArg, threadRootId, mentionsArg });
        return { ...persisted, deliveryId: undefined, target: "@frank" };
      },
    } satisfies DirectConversationRepository;
    const useCase = sendDirectMessage(repository, quietCentrifugo());

    await useCase.executeFromAgent({
      idempotencyKey: "attachment-mention-request",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      target: "@frank",
      body: "hi @ada",
      attachmentIds,
      mentions,
    });

    expect(calls).toEqual([
      {
        conversationId: "conversation-a",
        agentId: "agent-a",
        body: "hi @ada",
        attachmentIdsArg: attachmentIds,
        threadRootId: undefined,
        mentionsArg: mentions,
      },
    ]);
  });

  test("does not publish when Agent persistence fails", async () => {
    let published = false;
    const repository = {
      async sendMessage() {
        throw new Error("not used");
      },
      async userIdForUsername() {
        return "internal-user";
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
        throw new Error("persistence failed");
      },
    } satisfies DirectConversationRepository;
    const useCase = sendDirectMessage(
      repository,
      withPublishBatch({
        async publish() {
          published = true;
        },
      }),
    );
    await expect(
      useCase.executeFromAgent({
        idempotencyKey: "request-a",
        workspaceId: "workspace-a",
        agentId: "agent-a",
        target: "@user",
        body: "Hi",
      }),
    ).rejects.toThrow("persistence failed");
    expect(published).toBe(false);
  });

  test("does not invoke publication even when the publication adapter fails", async () => {
    let persistedCalled = false;
    const calls: string[] = [];
    const repository = {
      async sendMessage() {
        throw new Error("not used");
      },
      async userIdForUsername() {
        return "internal-user";
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
        persistedCalled = true;
        return { ...persisted, deliveryId: undefined, target: "@user" };
      },
    } satisfies DirectConversationRepository;
    const useCase = sendDirectMessage(
      repository,
      withPublishBatch({
        async publish() {
          throw new Error("should not be called");
        },
      }),
      {
        async memberChanged() {},
        async messageAvailable({ messageId }) {
          calls.push(`notify:${messageId}`);
        },
      },
    );
    await expect(
      useCase.executeFromAgent({
        idempotencyKey: "request-a",
        workspaceId: "workspace-a",
        agentId: "agent-a",
        target: "@user",
        body: "Hi",
      }),
    ).resolves.toMatchObject({ id: "message-a", sequence: 1 });
    expect(persistedCalled).toBe(true);
    expect(calls).toEqual(["notify:message-a"]);
  });
});
