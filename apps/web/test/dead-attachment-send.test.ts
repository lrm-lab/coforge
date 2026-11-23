import { describe, expect, test } from "bun:test";
import { AppError, isAppError } from "#src/lib/app-error";
import { claimUploadedAttachments } from "#src/server/attachments/message-attachments.server";
import { sendChannel } from "#src/server/conversations/channel-send.server";
import type {
  MessageRequestIdempotency,
  PersistedDirectMessage,
} from "#src/server/conversations/message-request-idempotency.server";
import {
  canEditUnsent,
  hasLocalAttachmentFiles,
  restoredChipsForEdit,
} from "#src/features/conversations/use-message-outbox";
import type { OutboxEntry } from "#src/features/conversations/composer-outbox";
import type { PendingAttachment } from "#src/features/conversations/composer-attachments";

function inMemoryIdempotency(): MessageRequestIdempotency {
  const completed = new Map<string, PersistedDirectMessage>();
  return {
    async execute(scope, persist) {
      const key = `${scope.workspaceId}:${scope.senderKind}:${scope.senderId}:${scope.idempotencyKey}`;
      const existing = completed.get(key);
      if (existing) return existing;
      const result = await persist();
      completed.set(key, result);
      return result;
    },
  };
}

describe("claimUploadedAttachments", () => {
  test("throws ATTACHMENTS_UNAVAILABLE naming only the caller's missing ids", async () => {
    const tx = {
      attachment: {
        findMany: async () => [
          {
            id: "valid-1",
            fileName: "valid.txt",
            contentType: "text/plain",
            sizeBytes: 12,
          },
        ],
      },
    };
    let caught: unknown;
    try {
      await claimUploadedAttachments(
        tx as never,
        { workspaceId: "ws-1", conversationId: "conv-1", uploaderId: "user-1" },
        ["expired-1", "valid-1", "expired-1"],
      );
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    expect((caught as AppError).code).toBe("ATTACHMENTS_UNAVAILABLE");
    expect((caught as AppError).details).toEqual({ attachmentIds: "expired-1" });
  });

  test("preserves send order when every attachment is available", async () => {
    const tx = {
      attachment: {
        findMany: async () => [
          { id: "b", fileName: "b.txt", contentType: "text/plain", sizeBytes: 2 },
          { id: "a", fileName: "a.txt", contentType: "text/plain", sizeBytes: 1 },
        ],
      },
    };
    const claimed = await claimUploadedAttachments(
      tx as never,
      { workspaceId: "ws-1", conversationId: "conv-1", uploaderId: "user-1" },
      ["a", "b"],
    );
    expect(claimed.map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("sendChannel dead attachment contract", () => {
  test("keeps ACCESS_DENIED when the sender cannot post in the channel", async () => {
    let attachmentQueried = false;
    const db = {
      workspaceMembership: {
        findUnique: async () => ({ id: "wm-1", role: "member" }),
      },
      conversation: {
        findFirst: async () => ({
          id: "ch-1",
          workspaceId: "ws-1",
          channelName: "general",
          visibility: "public",
          archivedAt: null,
        }),
      },
      conversationMember: {
        findFirst: async () => null,
      },
      $transaction: async () => {
        attachmentQueried = true;
        throw new Error("should not reach transaction");
      },
    };
    let caught: unknown;
    try {
      await sendChannel(
        { db: db as never, idempotency: inMemoryIdempotency() },
        {
          workspaceId: "ws-1",
          userId: "outsider",
          channelId: "ch-1",
          idempotencyKey: "key-1",
          body: "hello",
          attachmentIds: ["expired-1"],
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    expect((caught as AppError).code).toBe("ACCESS_DENIED");
    expect(attachmentQueried).toBe(false);
  });

  test("rejects unclaimable attachments with ATTACHMENTS_UNAVAILABLE without poisoning idempotency", async () => {
    const availableIds = new Set(["valid-1"]);
    const createdMessages: string[] = [];
    const linkedAttachments: { id: string; messageId: string; position: number }[] = [];

    const tx = {
      $queryRaw: async () => [{ id: "ch-1" }],
      conversation: {
        findFirst: async () => null,
        update: async () => ({ lastSequence: createdMessages.length + 1 }),
      },
      attachment: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.filter((id) => availableIds.has(id)).map((id) => ({ id })),
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { messageId: string; position: number };
        }) => {
          linkedAttachments.push({ id: where.id, ...data });
          return {
            id: where.id,
            fileName: `${where.id}.txt`,
            contentType: "text/plain",
            sizeBytes: 10,
          };
        },
      },
      conversationMember: {
        findMany: async () => [],
        update: async () => ({}),
        updateMany: async () => ({ count: 1 }),
      },
      user: {
        findUnique: async () => ({
          id: "user-1",
          username: "dev",
          displayName: "Dev User",
          avatarUrl: null,
        }),
      },
      message: {
        create: async ({ data }: { data: { body: string; sequence: number } }) => {
          const id = `msg-${createdMessages.length + 1}`;
          createdMessages.push(id);
          return {
            id,
            body: data.body,
            createdAt: new Date("2026-11-24T00:00:00Z"),
            sequence: data.sequence,
            threadRootId: null,
          };
        },
      },
    };

    const db = {
      workspaceMembership: {
        findUnique: async () => ({ id: "wm-1", role: "member" }),
      },
      conversation: {
        findFirst: async () => ({
          id: "ch-1",
          workspaceId: "ws-1",
          channelName: "general",
          visibility: "public",
          archivedAt: null,
        }),
      },
      conversationMember: {
        findFirst: async () => ({
          id: "member-1",
          userId: "user-1",
          leftAt: null,
          channelRole: "member",
        }),
        findMany: async () => [],
      },
      message: {
        findFirstOrThrow: async () => ({
          id: "msg-1",
          body: "hello",
          createdAt: new Date("2026-11-24T00:00:00Z"),
          sequence: 1,
          threadRootId: null,
          senderMember: {
            id: "member-1",
            userId: "user-1",
            agentId: null,
            user: { id: "user-1", username: "dev", displayName: "Dev User", avatarUrl: null },
            agent: null,
          },
          attachments: linkedAttachments.map((item) => ({
            id: item.id,
            fileName: `${item.id}.txt`,
            contentType: "text/plain",
            sizeBytes: 10,
          })),
          deliveries: [],
        }),
      },
      mentionDelivery: {
        findMany: async () => [],
      },
      pendingMentionAction: {
        findMany: async () => [],
      },
      $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx),
    };

    const ports = {
      db: db as never,
      idempotency: inMemoryIdempotency(),
      realtime: {
        messageCreated: async () => {},
        viewerChanged: async () => {},
        channelChanged: async () => {},
      } as never,
      notifications: { notifyMessage: async () => {} } as never,
      publisher: { publish: async () => {}, batch: async () => ({ replies: [] }) } as never,
    };
    let caught: unknown;
    try {
      await sendChannel(ports, {
        workspaceId: "ws-1",
        userId: "user-1",
        channelId: "ch-1",
        idempotencyKey: "key-1",
        body: "hello",
        attachmentIds: ["expired-1", "valid-1"],
      });
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    expect((caught as AppError).code).toBe("ATTACHMENTS_UNAVAILABLE");
    expect((caught as AppError).details).toEqual({ attachmentIds: "expired-1" });
    expect(createdMessages).toEqual([]);

    availableIds.add("replacement-2");
    const sent = await sendChannel(ports, {
      workspaceId: "ws-1",
      userId: "user-1",
      channelId: "ch-1",
      idempotencyKey: "key-1",
      body: "hello",
      attachmentIds: ["replacement-2", "valid-1"],
    });
    expect(sent.id).toBe("msg-1");
    expect(createdMessages).toEqual(["msg-1"]);
    expect(linkedAttachments.map((item) => item.id)).toEqual(["replacement-2", "valid-1"]);

    const retried = await sendChannel(ports, {
      workspaceId: "ws-1",
      userId: "user-1",
      channelId: "ch-1",
      idempotencyKey: "key-1",
      body: "hello",
      attachmentIds: ["replacement-2", "valid-1"],
    });
    expect(retried.id).toBe("msg-1");
    expect(createdMessages).toEqual(["msg-1"]);
  });
});

describe("restoredChipsForEdit and canEditUnsent", () => {
  const entry: OutboxEntry = {
    localId: "local-1",
    draftKey: "chat-a",
    body: "keep my text",
    pins: [],
    idempotencyKey: "idem-1",
    asTask: false,
    attachments: [
      { id: "expired-1", fileName: "expired.txt" },
      { id: "valid-1", fileName: "valid.txt" },
    ],
    state: "unsent",
    reason: "attachments_unavailable",
    unavailableAttachmentIds: ["expired-1"],
  };

  test("allows editing an attachments_unavailable entry even after reload without memory chips", () => {
    expect(canEditUnsent(entry)).toBe(true);
    const restored = restoredChipsForEdit(entry);
    expect(restored).toHaveLength(2);
    expect(restored[0]).toMatchObject({
      fileName: "expired.txt",
      failure: "expired",
    });
    expect(restored[0]!.id).toBeUndefined();
    expect(restored[0]!.file).toBeUndefined();
    expect(restored[1]).toMatchObject({
      fileName: "valid.txt",
      id: "valid-1",
      progress: 100,
    });
    expect(restored[1]!.failure).toBeUndefined();
  });

  test("clears only expired ids and preserves local File objects in the same session", () => {
    const expiredFile = new File(["expired"], "expired.txt", { type: "text/plain" });
    const validFile = new File(["valid"], "valid.txt", { type: "text/plain" });
    const chips: PendingAttachment[] = [
      { localId: "c1", file: expiredFile, id: "expired-1", progress: 100 },
      { localId: "c2", file: validFile, id: "valid-1", progress: 100 },
    ];
    const restored = restoredChipsForEdit(entry, chips);
    expect(restored[0]).toEqual({
      localId: "c1",
      file: expiredFile,
      id: undefined,
      progress: 0,
      failure: "expired",
    });
    expect(restored[1]).toEqual(chips[1]);
  });

  test("keeps valid attachments intact when unavailableAttachmentIds is missing", () => {
    const abnormal: OutboxEntry = {
      ...entry,
      unavailableAttachmentIds: undefined,
    };
    const restored = restoredChipsForEdit(abnormal);
    expect(restored.every((chip) => chip.failure === undefined && Boolean(chip.id))).toBe(true);
  });

  test("prompts to reselect when a server-only restored attachment fails on a later send", () => {
    const secondFailure: OutboxEntry = {
      ...entry,
      localId: "local-2",
      attachments: [{ id: "valid-1", fileName: "valid.txt" }],
      unavailableAttachmentIds: ["valid-1"],
    };
    const serverOnlyChips: PendingAttachment[] = [
      { localId: "c-restored", fileName: "valid.txt", id: "valid-1", progress: 100 },
    ];
    expect(hasLocalAttachmentFiles(secondFailure, serverOnlyChips)).toBe(false);
    const localFile = new File(["valid"], "valid.txt", { type: "text/plain" });
    const withLocalFileChips: PendingAttachment[] = [
      { localId: "c-local", file: localFile, id: "valid-1", progress: 100 },
    ];
    expect(hasLocalAttachmentFiles(secondFailure, withLocalFileChips)).toBe(true);
  });
});
