import { expect, test } from "bun:test";
import {
  CentrifugoConversationRealtime,
  announceJoinedOrLeft,
  announceViewerEvent,
} from "#src/server/conversations/conversation-realtime.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";

/** Records what reaches each channel, whether one `publish` or one `broadcast` carried it, and
 * every subscription it is asked to end. */
function recordingCentrifugo() {
  const published: { channel: string; data: unknown }[] = [];
  const unsubscribed: { user: string; channel: string }[] = [];
  const centrifugo = {
    publishJson: async (channel: string, data: unknown) => {
      published.push({ channel, data });
    },
    broadcast: async (channels: string[], data: unknown) => {
      for (const channel of channels) published.push({ channel, data });
    },
    unsubscribe: async (subscriptions: { user: string; channel: string }[]) => {
      unsubscribed.push(...subscriptions);
    },
  } as unknown as CentrifugoServerApi;
  return { centrifugo, published, unsubscribed };
}

test("a viewer event goes only to each named person's own channel, never the Workspace", async () => {
  const { centrifugo, published } = recordingCentrifugo();
  const event = {
    type: "channel.joined.v1" as const,
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
  };
  await announceViewerEvent(new CentrifugoConversationRealtime(centrifugo), {
    userIds: ["ada", "grace"],
    event,
  });
  expect(published).toEqual([
    { channel: "chat:user:ada", data: event },
    { channel: "chat:user:grace", data: event },
  ]);
});

test("announcing to nobody publishes nothing, and a failed publish never fails the write", async () => {
  const { centrifugo, published } = recordingCentrifugo();
  const event = {
    type: "pref.changed.v1" as const,
    workspaceId: "workspace-1",
    name: "pins" as const,
  };
  await announceViewerEvent(new CentrifugoConversationRealtime(centrifugo), { userIds: [], event });
  expect(published).toEqual([]);

  const down = async () => {
    throw new Error("centrifugo down");
  };
  const failing = { publishJson: down, broadcast: down } as unknown as CentrifugoServerApi;
  await expect(
    announceViewerEvent(new CentrifugoConversationRealtime(failing), { userIds: ["ada"], event }),
  ).resolves.toBeUndefined();
});

test("a created channel is announced to the whole Workspace", async () => {
  const { centrifugo, published } = recordingCentrifugo();
  await new CentrifugoConversationRealtime(centrifugo).channelCreated({
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    channel: { name: "lab", description: "", archived: false },
    memberUserIds: undefined,
  });
  expect(published).toEqual([
    {
      channel: "chat:workspace:workspace-1",
      data: {
        type: "channel.created.v1",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        channel: { name: "lab", description: "", archived: false },
      },
    },
  ]);
});

test("a private channel's creation, change and Tasks reach only its people's own channels", async () => {
  const { centrifugo, published } = recordingCentrifugo();
  const realtime = new CentrifugoConversationRealtime(centrifugo);
  const channel = { name: "secret", description: "", archived: false };
  const scope = { workspaceId: "workspace-1", conversationId: "conversation-1" };
  await realtime.channelCreated({ ...scope, channel, memberUserIds: ["ada", "grace"] });
  await realtime.channelUpdated({ ...scope, gone: true, memberUserIds: ["ada"] });
  await realtime.taskChanged({
    ...scope,
    tasks: [],
    deleted: ["task-1"],
    memberUserIds: ["grace"],
    publicationId: "conversation-1:channel-deleted",
  });
  expect(published).toEqual([
    { channel: "chat:user:ada", data: { type: "channel.created.v1", ...scope, channel } },
    { channel: "chat:user:grace", data: { type: "channel.created.v1", ...scope, channel } },
    { channel: "chat:user:ada", data: { type: "channel.updated.v1", ...scope, gone: true } },
    { channel: "chat:conversation-1", data: { type: "channel.updated.v1", ...scope, gone: true } },
    {
      channel: "chat:user:grace",
      data: {
        type: "task.changed.v1",
        ...scope,
        tasks: [],
        deleted: ["task-1"],
        privateChannel: true,
      },
    },
  ]);
});

test("a private channel nobody is in announces its creation to no one", async () => {
  const { centrifugo, published } = recordingCentrifugo();
  await new CentrifugoConversationRealtime(centrifugo).channelCreated({
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    channel: { name: "secret", description: "", archived: false },
    memberUserIds: [],
  });
  expect(published).toEqual([]);
});

test("leaving a private channel ends the leaver's subscriptions to it; a public one keeps them", async () => {
  const { centrifugo, unsubscribed } = recordingCentrifugo();
  const realtime = new CentrifugoConversationRealtime(centrifugo);
  const scope = { workspaceId: "workspace-1", conversationId: "conversation-1" };
  await announceJoinedOrLeft(realtime, { ...scope, change: "left", userIds: ["ada"] });
  await announceJoinedOrLeft(realtime, {
    ...scope,
    change: "joined",
    userIds: ["ada"],
    private: true,
  });
  expect(unsubscribed).toEqual([]);
  await announceJoinedOrLeft(realtime, {
    ...scope,
    change: "left",
    userIds: ["ada", "grace"],
    private: true,
  });
  expect(unsubscribed).toEqual([
    { user: "ada", channel: "chat:conversation-1" },
    { user: "grace", channel: "chat:conversation-1" },
  ]);
});
