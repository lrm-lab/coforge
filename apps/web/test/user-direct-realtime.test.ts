import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  CentrifugoConversationRealtime,
  conversationSignalScopes,
} from "#src/server/conversations/conversation-realtime.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { UserDirectConversations } from "#src/server/conversations/user-direct-conversations.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import { announceMessage } from "#src/server/conversations/conversation-activity.server";

const directConversation = (
  directKey: string,
  members: { userId: string | null; agentId: string | null }[],
) =>
  ({
    conversation: { findUnique: async () => ({ channelName: null, directKey, members }) },
  }) as unknown as PrismaClient;

function recordingCentrifugo() {
  const published: { channel: string; data: Record<string, unknown> }[] = [];
  const centrifugo = {
    publishJson: async (channel: string, data: Record<string, unknown>) => {
      published.push({ channel, data });
    },
    broadcast: async (channels: string[], data: Record<string, unknown>) => {
      for (const channel of channels) published.push({ channel, data });
    },
  } as unknown as CentrifugoServerApi;
  return { centrifugo, published };
}

/** The message `announceMessage` reads for the row's activity: Ada's, in a direct conversation. */
const storedMessage = {
  findUnique: async () => ({
    body: "hello",
    createdAt: new Date("2026-10-29T00:00:00Z"),
    threadRootId: null,
    workspaceId: "workspace-1",
    conversation: { channelName: null },
    sender: {
      userId: "ada",
      agentId: null,
      user: { displayName: "Ada", username: "ada" },
      agent: null,
    },
    mentions: [],
  }),
};

const channelsOf = (published: { channel: string }[]) =>
  published.map((publication) => publication.channel).sort();
const activityTo = (published: { channel: string; data: Record<string, unknown> }[]) =>
  published
    .filter((publication) => publication.data.type === "conversation.activity.v1")
    .map((publication) => publication.channel)
    .sort();

test("a direct conversation between people signals only its members, never the Workspace", async () => {
  const scopes = await conversationSignalScopes(
    directConversation("user:ada|user:grace", [
      { userId: "ada", agentId: null },
      { userId: "grace", agentId: null },
    ]),
    "conversation-1",
    "workspace-1",
  );
  const { centrifugo, published } = recordingCentrifugo();
  const realtime = new CentrifugoConversationRealtime(centrifugo);
  await announceMessage({ message: storedMessage } as unknown as PrismaClient, realtime, {
    conversationId: "conversation-1",
    messageId: "message-1",
    sequence: 1,
    ...scopes.message,
  });
  await realtime.taskChanged({
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    tasks: [],
    deleted: [],
    publicationId: "p1",
    ...scopes.task,
  });

  // The open page hears the message on the conversation's own channel; each member's own channel
  // gets the row's activity and the Tasks change. Nothing goes to the Workspace's channel.
  expect(channelsOf(published)).toEqual([
    "chat:conversation-1",
    "chat:user:ada",
    "chat:user:ada",
    "chat:user:grace",
    "chat:user:grace",
  ]);
  expect(activityTo(published)).toEqual(["chat:user:ada", "chat:user:grace"]);
});

test("a Tasks change in a direct conversation between people reaches its members in one broadcast", async () => {
  const calls: { method: string; channels: string[]; idempotencyKey?: string }[] = [];
  const centrifugo = {
    publishJson: async (channel: string, _data: unknown, idempotencyKey?: string) => {
      calls.push({ method: "publishJson", channels: [channel], idempotencyKey });
    },
    broadcast: async (channels: string[], _data: unknown, idempotencyKey?: string) => {
      calls.push({ method: "broadcast", channels, idempotencyKey });
    },
  } as unknown as CentrifugoServerApi;

  await new CentrifugoConversationRealtime(centrifugo).taskChanged({
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    tasks: [],
    deleted: [],
    publicationId: "p1",
    directUserIds: ["ada", "grace"],
  });

  expect(calls).toEqual([
    { method: "broadcast", channels: ["chat:user:ada", "chat:user:grace"], idempotencyKey: "p1" },
  ]);
});

test("a member's conversation with themself signals only them", async () => {
  const scopes = await conversationSignalScopes(
    directConversation("user:ada|user:ada", [{ userId: "ada", agentId: null }]),
    "conversation-2",
    "workspace-1",
  );
  const { centrifugo, published } = recordingCentrifugo();
  await announceMessage(
    { message: storedMessage } as unknown as PrismaClient,
    new CentrifugoConversationRealtime(centrifugo),
    { conversationId: "conversation-2", messageId: "message-2", sequence: 1, ...scopes.message },
  );
  expect(channelsOf(published)).toEqual(["chat:conversation-2", "chat:user:ada"]);
});

test("a member is still signalled, the other still named by the key, after the other's member row is gone", async () => {
  const scopes = await conversationSignalScopes(
    directConversation("user:ada|user:grace", [{ userId: "ada", agentId: null }]),
    "conversation-3",
    "workspace-1",
  );
  expect(scopes.message).toMatchObject({ directUserIds: ["ada"], directPair: ["ada", "grace"] });
  const { centrifugo, published } = recordingCentrifugo();
  await announceMessage(
    { message: storedMessage } as unknown as PrismaClient,
    new CentrifugoConversationRealtime(centrifugo),
    { conversationId: "conversation-3", messageId: "message-3", sequence: 1, ...scopes.message },
  );
  expect(channelsOf(published)).toEqual(["chat:conversation-3", "chat:user:ada"]);
});

test("a person's message in a direct conversation also signals the sender's own channel", async () => {
  const { centrifugo, published } = recordingCentrifugo();
  const db = {
    conversation: {
      findFirst: async () => ({
        directKey: "user:ada|user:grace",
        members: [
          { id: "member-ada", userId: "ada" },
          { id: "member-grace", userId: "grace" },
        ],
      }),
    },
    message: storedMessage,
  } as unknown as PrismaClient;
  const idempotency = {
    execute: async () => ({ id: "message-4", sequence: 1 }),
  } as unknown as MessageRequestIdempotency;
  await new UserDirectConversations(
    db,
    idempotency,
    new CentrifugoConversationRealtime(centrifugo),
  ).send({
    workspaceId: "workspace-1",
    conversationId: "conversation-4",
    senderUserId: "ada",
    body: "hello",
    idempotencyKey: "request-4",
  });

  expect(channelsOf(published)).toEqual([
    "chat:conversation-4",
    "chat:user:ada",
    "chat:user:grace",
  ]);
  const activity = published.find((publication) => publication.channel === "chat:user:ada")?.data;
  expect(activity).toMatchObject({ type: "conversation.activity.v1", senderUserId: "ada" });
});

test("a member's own conversation signals them once, even when a member row repeats their id", async () => {
  const { centrifugo, published } = recordingCentrifugo();
  await announceMessage(
    { message: storedMessage } as unknown as PrismaClient,
    new CentrifugoConversationRealtime(centrifugo),
    {
      conversationId: "conversation-5",
      messageId: "message-5",
      sequence: 1,
      directUserIds: ["ada", "ada"],
      directPair: ["ada", "ada"],
      senderUserId: "ada",
    },
  );
  expect(channelsOf(published)).toEqual(["chat:conversation-5", "chat:user:ada"]);
});
