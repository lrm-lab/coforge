import { expect, test } from "bun:test";
import {
  CentrifugoConversationRealtime,
  announceViewerEvent,
  announceViewerEvents,
} from "#src/server/conversations/conversation-realtime.server";
import { announceJoinedOrLeft } from "#src/server/conversations/channel-membership-signals.server";

import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";

/** Records what reaches each channel, whether one `publish` or one `broadcast` carried it, and
 * every subscription it is asked to end. */
function recordingCentrifugo() {
  const published: { channel: string; data: unknown }[] = [];
  const batches: { channel: string; data: unknown }[][] = [];
  const batchKeys: (string | undefined)[][] = [];
  const unsubscribed: { user: string; channel: string }[] = [];
  const centrifugo = {
    publishJson: async (channel: string, data: unknown) => {
      published.push({ channel, data });
    },
    broadcast: async (channels: string[], data: unknown) => {
      for (const channel of channels) published.push({ channel, data });
    },
    publishJsonBatch: async (
      publications: readonly { channel: string; data: unknown; idempotencyKey?: string }[],
    ): Promise<PromiseSettledResult<void>[]> => {
      batches.push(publications.map(({ channel, data }) => ({ channel, data })));
      batchKeys.push(publications.map((publication) => publication.idempotencyKey));
      return publications.map(() => ({ status: "fulfilled" as const, value: undefined }));
    },
    unsubscribe: async (subscriptions: { user: string; channel: string }[]) => {
      unsubscribed.push(...subscriptions);
    },
  } as unknown as CentrifugoServerApi;
  return { centrifugo, published, batches, batchKeys, unsubscribed };
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
    channel: { name: "lab", description: "", archived: false, visibility: "public" as const },
    memberUserIds: undefined,
  });
  expect(published).toEqual([
    {
      channel: "chat:workspace:workspace-1",
      data: {
        type: "channel.created.v1",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        channel: { name: "lab", description: "", archived: false, visibility: "public" as const },
      },
    },
  ]);
});

test("a private channel's creation, change and Tasks reach only its people's own channels", async () => {
  const { centrifugo, published } = recordingCentrifugo();
  const realtime = new CentrifugoConversationRealtime(centrifugo);
  const channel = {
    name: "secret",
    description: "",
    archived: false,
    visibility: "public" as const,
  };
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
      },
    },
  ]);
});

test("a private channel nobody is in announces its creation to no one", async () => {
  const { centrifugo, published } = recordingCentrifugo();
  await new CentrifugoConversationRealtime(centrifugo).channelCreated({
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    channel: { name: "secret", description: "", archived: false, visibility: "public" as const },
    memberUserIds: [],
  });
  expect(published).toEqual([]);
});

test("several viewer events go out in one batch, each to every named person's own channel", async () => {
  const { centrifugo, batches, batchKeys, published } = recordingCentrifugo();
  const events = [
    {
      type: "channel.marked.v1" as const,
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      unreadCount: 0,
      readThroughSequence: 3,
    },
    {
      type: "dm.marked.v1" as const,
      workspaceId: "workspace-1",
      conversationId: "conversation-2",
      unreadCount: 2,
      readThroughSequence: 9,
    },
  ];
  await announceViewerEvents(new CentrifugoConversationRealtime(centrifugo), {
    userIds: ["ada", "grace"],
    events,
  });
  expect(published).toEqual([]);
  expect(batches).toEqual([
    [
      { channel: "chat:user:ada", data: events[0] },
      { channel: "chat:user:ada", data: events[1] },
      { channel: "chat:user:grace", data: events[0] },
      { channel: "chat:user:grace", data: events[1] },
    ],
  ]);
  // Each publication carries its own fresh key, as a lone `viewerChanged` publish does.
  expect(batchKeys[0]).toHaveLength(4);
  expect(batchKeys[0]?.every((key) => typeof key === "string" && key !== "")).toBe(true);
  expect(new Set(batchKeys[0]).size).toBe(4);
});

test("a refused publication fails the batched announcement best-effort, never the write", async () => {
  const centrifugo = {
    publishJsonBatch: async () => [
      { status: "fulfilled" as const, value: undefined },
      { status: "rejected" as const, reason: new Error("Centrifugo publish failed (102)") },
    ],
  } as unknown as CentrifugoServerApi;
  const event = {
    type: "channel.marked.v1" as const,
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    unreadCount: 0,
    readThroughSequence: 3,
  };
  await expect(
    announceViewerEvents(new CentrifugoConversationRealtime(centrifugo), {
      userIds: ["ada"],
      events: [event, event],
    }),
  ).resolves.toBeUndefined();
});

test("a port without the batch method still gets each viewer event on its own", async () => {
  const calls: { userIds: readonly string[]; event: unknown }[] = [];
  const realtime = {
    viewerChanged: async (input: { userIds: readonly string[]; event: unknown }) => {
      calls.push(input);
    },
  };
  const events = [
    {
      type: "channel.marked.v1" as const,
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      unreadCount: 0,
      readThroughSequence: 3,
    },
    {
      type: "dm.marked.v1" as const,
      workspaceId: "workspace-1",
      conversationId: "conversation-2",
      unreadCount: 2,
      readThroughSequence: 9,
    },
  ];
  await announceViewerEvents(realtime, { userIds: ["ada"], events });
  expect(calls).toEqual(events.map((event) => ({ userIds: ["ada"], event })));
});

test("announcing several viewer events to nobody, or none at all, publishes nothing", async () => {
  const { centrifugo, batches, published } = recordingCentrifugo();
  const realtime = new CentrifugoConversationRealtime(centrifugo);
  const event = {
    type: "channel.marked.v1" as const,
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    unreadCount: 0,
    readThroughSequence: 3,
  };
  await announceViewerEvents(realtime, { userIds: [], events: [event] });
  await announceViewerEvents(realtime, { userIds: ["ada"], events: [] });
  expect(batches).toEqual([]);
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
