import { describe, expect, test } from "bun:test";

import {
  CHANNEL_DESCRIPTION_MAX_LENGTH,
  CHANNEL_NAME_MAX_LENGTH,
  updatePublicChannelInfoInputSchema,
} from "#src/features/conversations/conversation.schemas";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  listUserSavedMessages,
  savedMessageView,
  type SavedMessageRow,
} from "#src/server/conversations/saved-messages.server";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function row(overrides: {
  message?: Partial<SavedMessageRow["message"]>;
  savedAt?: Date;
  conversation?: Partial<SavedMessageRow["conversation"]> &
    Pick<SavedMessageRow["conversation"], "id" | "channelName" | "visibility" | "directKey">;
}): SavedMessageRow {
  return {
    createdAt: overrides.savedAt ?? new Date("2026-09-23T02:00:00Z"),
    conversation: {
      members: [],
      ...(overrides.conversation ?? {
        id: "22222222-2222-4222-8222-222222222222",
        channelName: "coforge",
        visibility: "public",
        directKey: null,
      }),
    },
    message: {
      id: "33333333-3333-4333-8333-333333333333",
      sequence: 7,
      threadRootId: null,
      senderMemberId: "44444444-4444-4444-8444-444444444444",
      body: "hello **world**",
      systemMessage: null,
      createdAt: new Date("2026-09-23T01:00:00Z"),
      attachments: [],
      sender: {
        userId: "55555555-5555-4555-8555-555555555555",
        agentId: null,
        user: { username: "frank", displayName: "Frank", avatarObjectKey: null },
        agent: null,
      },
      mentions: [],
      reactionVersion: 0,
      reactions: [],
      forwards: [],
      actionCard: null,
      ...overrides.message,
    },
  };
}

describe("savedMessageView", () => {
  test("an action card carries what its line is written from; any other message carries none", () => {
    const card = savedMessageView(
      row({
        message: {
          body: "Action card: create channel #launch",
          actionCard: {
            kind: "channel:create",
            payload: { type: "channel:create", name: "launch", visibility: "public" },
            draftHint: null,
          },
        },
      }),
      WORKSPACE_ID,
    );
    expect(card.message.card).toEqual({ kind: "channel:create", params: { name: "launch" } });
    expect(savedMessageView(row({}), WORKSPACE_ID).message).not.toHaveProperty("card");
  });

  test("carries savedAt and conversation context beside the browser message", () => {
    const savedAt = new Date("2026-09-23T02:34:56Z");
    const view = savedMessageView(row({ savedAt }), WORKSPACE_ID);
    expect(view.savedAt).toEqual(savedAt);
    expect(view.conversation).toEqual({
      id: "22222222-2222-4222-8222-222222222222",
      channelName: "coforge",
      visibility: "public",
      directKey: null,
    });
    expect(view.message.id).toBe("33333333-3333-4333-8333-333333333333");
    expect(view.message.body).toBe("hello **world**");
    expect(view.message.createdAt).toBe("2026-09-23T01:00:00.000Z");
    expect(view.message.mentions).toEqual([]);
    expect(view.message.reactions).toBeUndefined();
  });

  test("a private channel's entry carries its visibility, so the card shows no `#`", () => {
    const view = savedMessageView(
      row({
        conversation: {
          id: "22222222-2222-4222-8222-222222222222",
          channelName: "vault",
          visibility: "private",
          directKey: null,
        },
      }),
      WORKSPACE_ID,
    );
    expect(view.conversation.visibility).toBe("private");
  });

  test("maps a human sender with the Workspace avatar route when no CDN applies", () => {
    const view = savedMessageView(
      row({
        message: {
          sender: {
            userId: "55555555-5555-4555-8555-555555555555",
            agentId: null,
            user: {
              username: "frank",
              displayName: "Frank",
              avatarObjectKey: "users/55555555/a.png",
            },
            agent: null,
          },
        },
      }),
      WORKSPACE_ID,
    );
    expect(view.message.senderKind).toBe("user");
    expect(view.message.senderName).toBe("Frank");
    expect(view.message.senderHandle).toBe("frank");
    expect(view.message.senderAvatarUrl).toBe(
      `/api/workspaces/${WORKSPACE_ID}/users/55555555-5555-4555-8555-555555555555/avatar?v=55555555`,
    );
    expect(view.message.senderDeleted).toBe(false);
  });

  test("maps a deleted agent sender greyed and a system sender with no identity", () => {
    const agentView = savedMessageView(
      row({
        message: {
          senderMemberId: "66666666-6666-4666-8666-666666666666",
          sender: {
            userId: null,
            agentId: "77777777-7777-4777-8777-777777777777",
            user: null,
            agent: {
              name: "muse",
              displayName: "Muse",
              deletedAt: new Date("2026-09-20T00:00:00Z"),
              avatarMascot: null,
              appBot: null,
            },
          },
        },
      }),
      WORKSPACE_ID,
    );
    expect(agentView.message.senderKind).toBe("agent");
    expect(agentView.message.senderDeleted).toBe(true);
    expect(agentView.message.senderAgentId).toBe("77777777-7777-4777-8777-777777777777");

    const systemView = savedMessageView(
      row({
        message: {
          senderMemberId: null,
          sender: null,
        },
      }),
      WORKSPACE_ID,
    );
    expect(systemView.message.senderKind).toBe("system");
    expect(systemView.message.senderAvatarUrl).toBeNull();
    expect(systemView.message.senderName).toBe("System");
  });

  test("resolves the DM peer instead of the viewer when the viewer saves their own DM message", () => {
    const viewerId = "55555555-5555-4555-8555-555555555555";
    const peerId = "88888888-8888-4888-8888-888888888888";
    const peopleDmView = savedMessageView(
      row({
        conversation: {
          id: "22222222-2222-4222-8222-222222222222",
          channelName: null,
          visibility: "public",
          directKey: `user:${viewerId}|user:${peerId}`,
          members: [
            {
              userId: viewerId,
              agentId: null,
              user: {
                id: viewerId,
                username: "konstantin",
                displayName: "Konstantin",
                avatarObjectKey: null,
              },
              agent: null,
            },
            {
              userId: peerId,
              agentId: null,
              user: {
                id: peerId,
                username: "aleksandra",
                displayName: "Aleksandra Wiśniewska-Kowalczyk",
                avatarObjectKey: null,
              },
              agent: null,
            },
          ],
        },
        message: {
          sender: {
            userId: viewerId,
            agentId: null,
            user: { username: "konstantin", displayName: "Konstantin", avatarObjectKey: null },
            agent: null,
          },
        },
      }),
      WORKSPACE_ID,
      viewerId,
    );
    expect(peopleDmView.conversation.peer).toEqual({
      kind: "user",
      id: peerId,
      name: "Aleksandra Wiśniewska-Kowalczyk",
      avatarUrl: expect.any(String),
    });

    const agentId = "77777777-7777-4777-8777-777777777777";
    const agentDmView = savedMessageView(
      row({
        conversation: {
          id: "99999999-9999-4999-8999-999999999999",
          channelName: null,
          visibility: "public",
          directKey: `agent:${agentId}|user:${viewerId}`,
          members: [
            {
              userId: viewerId,
              agentId: null,
              user: {
                id: viewerId,
                username: "konstantin",
                displayName: "Konstantin",
                avatarObjectKey: null,
              },
              agent: null,
            },
            {
              userId: null,
              agentId,
              user: null,
              agent: {
                id: agentId,
                name: "muse",
                displayName: "Muse",
                deletedAt: null,
                avatarMascot: null,
                appBot: null,
              },
            },
          ],
        },
      }),
      WORKSPACE_ID,
      viewerId,
    );
    expect(agentDmView.conversation.peer).toEqual({
      kind: "agent",
      id: agentId,
      name: "Muse",
      handle: "muse",
      avatarUrl: expect.any(String),
      deleted: false,
    });
  });
});

describe("updatePublicChannelInfoInputSchema and listUserSavedMessages bounds", () => {
  test("rejects oversized channel names and descriptions while allowing valid updates", () => {
    const channelId = "22222222-2222-4222-8222-222222222222";
    expect(
      updatePublicChannelInfoInputSchema.safeParse({
        channelId,
        name: "a".repeat(CHANNEL_NAME_MAX_LENGTH),
        description: "d".repeat(CHANNEL_DESCRIPTION_MAX_LENGTH),
      }).success,
    ).toBe(true);
    expect(
      updatePublicChannelInfoInputSchema.safeParse({
        channelId,
        name: "a".repeat(CHANNEL_NAME_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      updatePublicChannelInfoInputSchema.safeParse({
        channelId,
        description: "d".repeat(CHANNEL_DESCRIPTION_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  test("bounds listUserSavedMessages findMany queries and supports cursor pagination", async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    const db = {
      savedMessage: {
        findMany: async (args: Record<string, unknown>) => {
          capturedArgs = args;
          return [];
        },
      },
    } as unknown as PrismaClient;
    const cursorDate = new Date("2026-09-23T02:00:00Z");
    await listUserSavedMessages(db, {
      workspaceId: WORKSPACE_ID,
      userId: "55555555-5555-4555-8555-555555555555",
      limit: 99_999,
      cursor: { savedAt: cursorDate, messageId: "33333333-3333-4333-8333-333333333333" },
    } as Parameters<typeof listUserSavedMessages>[1]);
    expect(capturedArgs?.take).toBe(500);
    expect(capturedArgs?.orderBy).toEqual([{ createdAt: "desc" }, { messageId: "desc" }]);
    expect(capturedArgs?.where).toMatchObject({
      OR: [
        { createdAt: { lt: cursorDate } },
        { createdAt: cursorDate, messageId: { lt: "33333333-3333-4333-8333-333333333333" } },
      ],
    });
  });
});
