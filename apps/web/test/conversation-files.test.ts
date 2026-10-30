import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { listConversationFiles } from "#src/server/conversations/conversation-files.server";

function database(options: {
  workspaceMember?: boolean;
  conversation?: {
    directKey: string | null;
    channelName: string | null;
    visibility: string;
    members: object[];
  };
}) {
  const attachmentQueries: object[] = [];
  return {
    db: {
      workspaceMembership: {
        findUnique: async () => (options.workspaceMember === false ? null : { userId: "user-1" }),
      },
      conversation: {
        findFirst: async (input: { where?: { hiddenFromWorkspaceAt?: null } }) =>
          input.where?.hiddenFromWorkspaceAt === null ? (options.conversation ?? null) : null,
      },
      attachment: {
        findMany: async (input: object) => {
          attachmentQueries.push(input);
          return [
            {
              id: "attachment-1",
              fileName: "notes.txt",
              contentType: "text/plain",
              sizeBytes: 12,
              objectKey: "objects/attachment-1",
              imageWidth: null,
              imageHeight: null,
              createdAt: new Date("2026-10-27T00:00:00.000Z"),
              message: { id: "message-1" },
              uploader: { username: "alice", displayName: "Alice" },
              uploaderAgent: null,
            },
          ];
        },
      },
    } as unknown as PrismaClient,
    attachmentQueries,
  };
}

describe("conversation files authorization", () => {
  test("allows a Workspace member who has not joined a public channel", async () => {
    const { db, attachmentQueries } = database({
      conversation: { directKey: null, channelName: "general", visibility: "public", members: [] },
    });

    await expect(
      listConversationFiles(db, {
        workspaceId: "workspace-1",
        userId: "user-1",
        conversationId: "channel-1",
      }),
    ).resolves.toMatchObject({ files: [{ id: "attachment-1", fileName: "notes.txt" }] });
    expect(attachmentQueries).toHaveLength(1);
    expect(attachmentQueries[0]).toMatchObject({
      where: { conversationId: "channel-1", workspaceId: "workspace-1" },
    });
  });

  test("rejects a non-Workspace member", async () => {
    const { db, attachmentQueries } = database({
      workspaceMember: false,
      conversation: { directKey: null, channelName: "general", visibility: "public", members: [] },
    });

    await expect(
      listConversationFiles(db, {
        workspaceId: "workspace-1",
        userId: "outsider",
        conversationId: "channel-1",
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    expect(attachmentQueries).toHaveLength(0);
  });

  test("rejects a non-member of a private conversation", async () => {
    const { db, attachmentQueries } = database({
      conversation: {
        directKey: "agent:agent-1|user:user-2",
        channelName: null,
        visibility: "public",
        members: [],
      },
    });

    await expect(
      listConversationFiles(db, {
        workspaceId: "workspace-1",
        userId: "user-1",
        conversationId: "direct-1",
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    expect(attachmentQueries).toHaveLength(0);
  });

  test("rejects a hidden channel for every viewer", async () => {
    const { db, attachmentQueries } = database({ conversation: undefined });

    await expect(
      listConversationFiles(db, {
        workspaceId: "workspace-1",
        userId: "user-1",
        conversationId: "hidden-channel",
      }),
    ).rejects.toThrow("NOT_FOUND");
    expect(attachmentQueries).toHaveLength(0);
  });
});
