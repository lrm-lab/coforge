import { describe, expect, it } from "bun:test";

import { AppError } from "#src/lib/app-error";
import type { FileStorage, ManagedFileStorage } from "#src/server/files/file-storage.server";
import {
  listUserFeedback,
  loadUserFeedbackInbox,
  readFeedbackAttachment,
  saveFeedbackRoutingConfig,
  submitUserFeedback,
  updateUserFeedbackStatus,
} from "./feedback.server";

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
} {
  const keys = new Map<string, Blob>();
  const removed: string[] = [];
  return {
    keys,
    removed,
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
    },
    async head(objectKey) {
      const blob = keys.get(objectKey);
      return blob ? { sizeBytes: blob.size, contentType: blob.type || null } : null;
    },
  };
}

describe("feedback.server", () => {
  it("stores validated feedback, attachments, and dispatches channel routing post-commit", async () => {
    const storage = createMemoryStorage();
    const routedPayloads: unknown[] = [];
    let createdData: Record<string, unknown> | undefined;

    const db = {
      workspaceMembership: {
        findUnique: async () => ({ workspaceId: "ws-1" }),
      },
      userFeedback: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          createdData = data;
          return {
            id: "fb-1",
            category: data.category,
            body: data.body,
            pagePath: data.pagePath,
            clientInfo: data.clientInfo,
            createdAt: new Date("2026-11-26T09:00:00.000Z"),
            user: { displayName: "Frank", email: "frank@coforge.dev" },
            workspace: { name: "CoForge Core", slug: "coforge" },
          };
        },
      },
    } as never;

    const result = await submitUserFeedback(
      db,
      {
        userId: "user-1",
        workspaceId: "ws-1",
        category: "bug",
        body: "  Sidebar focus ring clips on hover  ",
        pagePath: "/w/coforge/channel/abc",
        clientInfo: "Web · macOS",
        files: [makePng("clip.png")],
      },
      {
        storage,
        routeToChannel: async (_db, payload) => {
          routedPayloads.push(payload);
          return null;
        },
      },
    );

    expect(result).toEqual({
      id: "fb-1",
      createdAt: "2026-11-26T09:00:00.000Z",
    });
    expect(storage.keys.size).toBe(1);
    const [storedKey] = [...storage.keys.keys()];
    expect(storedKey).toMatch(/^feedback\/[0-9a-f-]+\/original$/);
    expect(createdData?.body).toBe("Sidebar focus ring clips on hover");
    expect(createdData?.workspaceId).toBe("ws-1");
    expect(routedPayloads).toHaveLength(1);
    expect(routedPayloads[0]).toMatchObject({
      feedbackId: "fb-1",
      category: "bug",
      authorName: "Frank",
      workspaceName: "CoForge Core",
      attachments: [
        {
          fileName: "clip.png",
          contentType: "image/png",
          imageWidth: 1,
          imageHeight: 1,
        },
      ],
    });
  });

  it("never fails feedback submission if channel routing throws", async () => {
    const db = {
      userFeedback: {
        create: async ({ data }: { data: Record<string, unknown> }) => ({
          id: "fb-err",
          category: data.category,
          body: data.body,
          pagePath: null,
          clientInfo: null,
          createdAt: new Date("2026-11-26T09:00:00.000Z"),
          user: { displayName: "Frank", email: null },
          workspace: null,
        }),
      },
    } as never;

    const result = await submitUserFeedback(
      db,
      { userId: "user-1", category: "idea", body: "Resilient submit", files: [] },
      {
        routeToChannel: async () => {
          throw new Error("channel router exploded");
        },
      },
    );

    expect(result).toEqual({ id: "fb-err", createdAt: "2026-11-26T09:00:00.000Z" });
  });

  it("drops workspaceId when the user is not a member of that workspace", async () => {
    const storage = createMemoryStorage();
    let createdData: Record<string, unknown> | undefined;
    const db = {
      workspaceMembership: { findUnique: async () => null },
      userFeedback: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          createdData = data;
          return {
            id: "fb-2",
            category: data.category,
            body: data.body,
            pagePath: data.pagePath,
            clientInfo: data.clientInfo,
            createdAt: new Date("2026-11-26T09:00:00.000Z"),
            user: { displayName: "Frank", email: null },
            workspace: null,
          };
        },
      },
    } as never;

    await submitUserFeedback(
      db,
      {
        userId: "user-1",
        workspaceId: "ws-other",
        category: "idea",
        body: "Add keyboard shortcut for feedback",
        files: [],
      },
      { storage, routeToChannel: async () => null },
    );

    expect(createdData?.workspaceId).toBeNull();
  });

  it("rejects empty body, invalid category, too many files, or spoofed image bytes", async () => {
    const storage: FileStorage = createMemoryStorage();
    const db = {} as never;

    await expect(
      submitUserFeedback(
        db,
        { userId: "u1", category: "bug", body: "   ", files: [] },
        { storage },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await expect(
      submitUserFeedback(
        db,
        { userId: "u1", category: "unknown" as never, body: "hi", files: [] },
        { storage },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await expect(
      submitUserFeedback(
        db,
        {
          userId: "u1",
          category: "bug",
          body: "four shots",
          files: [makePng("1.png"), makePng("2.png"), makePng("3.png"), makePng("4.png")],
        },
        { storage },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const fakePng = new File([new Uint8Array([1, 2, 3, 4])], "fake.png", { type: "image/png" });
    await expect(
      submitUserFeedback(
        db,
        { userId: "u1", category: "bug", body: "spoofed", files: [fakePng] },
        { storage },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("removes uploaded objects if database creation fails", async () => {
    const storage = createMemoryStorage();
    const db = {
      userFeedback: {
        create: async () => {
          throw new Error("db down");
        },
      },
    } as never;

    await expect(
      submitUserFeedback(
        db,
        { userId: "u1", category: "bug", body: "db fails", files: [makePng()] },
        { storage, routeToChannel: async () => null },
      ),
    ).rejects.toThrow("db down");

    expect(storage.keys.size).toBe(0);
    expect(storage.removed).toHaveLength(1);
  });

  it("restricts inbox loading, listing, routing config, and status updates to platform operators", async () => {
    const nonOpDb = {
      platformOperator: { findUnique: async () => null },
    } as never;

    await expect(listUserFeedback(nonOpDb, "user-1")).rejects.toBeInstanceOf(AppError);
    await expect(listUserFeedback(nonOpDb, "user-1")).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    await expect(loadUserFeedbackInbox(nonOpDb, "user-1")).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    await expect(saveFeedbackRoutingConfig(nonOpDb, "user-1", null)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    await expect(
      updateUserFeedbackStatus(nonOpDb, "user-1", { feedbackId: "fb-1", status: "triaged" }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });

    let updatedStatus: string | undefined;
    let savedConversationId: string | null | undefined;
    const opDb = {
      platformOperator: { findUnique: async () => ({ role: "app_reviewer" }) },
      userFeedback: {
        findMany: async () => [
          {
            id: "fb-1",
            category: "idea",
            body: "Dark theme looks great",
            status: "open",
            pagePath: "/w/coforge",
            clientInfo: "Web · macOS",
            routedMessageId: "msg-9",
            createdAt: new Date("2026-11-26T09:00:00.000Z"),
            user: { id: "u1", displayName: "Frank", email: "frank@coforge.dev" },
            workspace: { id: "ws-1", name: "CoForge Core", slug: "coforge" },
            routedConversation: {
              id: "ch-1",
              channelName: "general",
              hiddenFromWorkspaceAt: null,
              workspace: { slug: "coforge" },
            },
            attachments: [
              { id: "att-1", fileName: "shot.png", contentType: "image/png", sizeBytes: 1200 },
            ],
          },
        ],
        updateMany: async ({ data }: { data: { status: string } }) => {
          updatedStatus = data.status;
          return { count: 1 };
        },
      },
      feedbackRoutingConfig: {
        findUnique: async () => ({
          conversation: {
            id: "ch-1",
            channelName: "general",
            archivedAt: null,
            hiddenFromWorkspaceAt: null,
            workspace: { id: "ws-1", slug: "coforge", name: "CoForge Core" },
          },
        }),
        upsert: async ({ update }: { update: { conversationId: string | null } }) => {
          savedConversationId = update.conversationId;
          return { id: 1, conversationId: update.conversationId };
        },
      },
      conversation: {
        findMany: async () => [
          {
            id: "ch-1",
            channelName: "general",
            workspace: { id: "ws-1", slug: "coforge", name: "CoForge Core" },
          },
        ],
        findFirst: async ({ where }: { where: { id: string } }) =>
          where.id === "ch-1"
            ? {
                id: "ch-1",
                channelName: "general",
                workspace: { id: "ws-1", slug: "coforge", name: "CoForge Core" },
              }
            : null,
      },
    } as never;

    const inbox = await loadUserFeedbackInbox(opDb, "op-1");
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]?.attachments[0]?.url).toBe("/api/feedback/attachments/att-1");
    expect(inbox.items[0]?.routedChannel).toEqual({
      workspaceSlug: "coforge",
      channelId: "ch-1",
      channelName: "general",
      messageId: "msg-9",
    });
    expect(inbox.routing).toEqual({
      channelId: "ch-1",
      channelName: "general",
      workspaceId: "ws-1",
      workspaceSlug: "coforge",
      workspaceName: "CoForge Core",
    });
    expect(inbox.routingOptions).toHaveLength(1);

    const saved = await saveFeedbackRoutingConfig(opDb, "op-1", "ch-1");
    expect(saved?.channelName).toBe("general");
    expect(savedConversationId).toBe("ch-1");

    const cleared = await saveFeedbackRoutingConfig(opDb, "op-1", null);
    expect(cleared).toBeNull();
    expect(savedConversationId).toBeNull();

    await expect(saveFeedbackRoutingConfig(opDb, "op-1", "ch-missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await updateUserFeedbackStatus(opDb, "op-1", { feedbackId: "fb-1", status: "resolved" });
    expect(updatedStatus).toBe("resolved");
  });

  it("authorizes attachment downloads for submitter and platform operator only", async () => {
    const storage = createMemoryStorage();
    await storage.put("feedback/k1/original", makePng(), "image/png");

    const dbFor = (isOperator: boolean) =>
      ({
        userFeedbackAttachment: {
          findUnique: async () => ({
            id: "att-1",
            fileName: "shot.png",
            contentType: "image/png",
            objectKey: "feedback/k1/original",
            feedback: { userId: "author-1" },
          }),
        },
        platformOperator: {
          findUnique: async () => (isOperator ? { role: "app_reviewer" } : null),
        },
      }) as never;

    const own = await readFeedbackAttachment(
      dbFor(false),
      { attachmentId: "att-1", userId: "author-1" },
      { storage },
    );
    expect(own.attachment.objectKey).toBe("feedback/k1/original");
    expect(await own.open()).not.toBeNull();

    const byOp = await readFeedbackAttachment(
      dbFor(true),
      { attachmentId: "att-1", userId: "operator-1" },
      { storage },
    );
    expect(byOp.attachment.fileName).toBe("shot.png");

    await expect(
      readFeedbackAttachment(
        dbFor(false),
        { attachmentId: "att-1", userId: "stranger-1" },
        { storage },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
