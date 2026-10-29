import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { createSidebar } from "#src/features/conversations/sidebar-collections";
import { applyConversationActivityToRow } from "#src/features/conversations/sidebar-signals";
import {
  sidebarChannelsQuery,
  sidebarDirectsQuery,
  type SidebarApi,
} from "#src/features/conversations/sidebar-queries";

/**
 * A message's `conversation.activity.v1` written into the sidebar row it changes, with no read:
 * the channel row's last message and the DM row's, and the answer that sends the caller to a
 * re-read when the list does not hold the row.
 */

const channel = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  name: id,
  joined: true,
  archived: false,
  muted: false,
  unreadCount: 0,
  mentioned: false,
  lastMessage: null,
  members: [],
  hidden: false,
  pinned: false,
  pinSortOrder: null,
  ...fields,
});

const sectionApi = {
  list: async () => [],
  order: async () => [],
  create: async () => ({
    id: "s",
    name: "S",
    emoji: null,
    collapsed: false,
    sortOrder: 0,
    sortMode: "manual" as const,
    conversationIds: [],
  }),
  update: async () => {},
  remove: async () => {},
  reorder: async () => {},
  move: async () => {},
};

async function sidebarWithChannels() {
  const api: SidebarApi = {
    sections: sectionApi,
    listChannels: async () => ({ streamPositions: {}, channels: [channel("general")] }),
    loadDirectPreferences: async () => ({
      conversations: [
        {
          conversationId: "dm-grace",
          peer: {
            kind: "people" as const,
            userId: "grace",
            username: "grace",
            displayName: "Grace",
            avatarUrl: null,
          },
          muted: false,
          lastMessage: null,
        },
      ],
      pinned: [],
      hidden: [],
      streamPositions: {},
    }),
    loadDirectBadges: async () => ({ viewerId: "viewer", unread: {}, streamPositions: {} }),
    pin: async () => {},
    setMuted: async () => {},
    markUnread: async () => {},
    close: async () => {},
    arrange: async () => {},
  };
  const queryClient = new QueryClient();
  await queryClient.query(sidebarChannelsQuery("w", api));
  await queryClient.query(sidebarDirectsQuery("w", { api }));
  const sidebar = createSidebar(queryClient, "w", api);
  await Promise.all([sidebar.channels.preload(), sidebar.directs.preload()]);
  return sidebar;
}

const activity = (over: Record<string, unknown>) => ({
  type: "conversation.activity.v1" as const,
  workspaceId: "w",
  conversationId: "general",
  kind: "channel" as const,
  messageId: "m1",
  sequence: 7,
  createdAt: "2026-10-29T08:00:00.000Z",
  preview: "a new line",
  sender: { kind: "user" as const, name: "Grace" },
  senderUserId: "grace",
  ...over,
});

test("a channel message writes that row's last message, with no read", async () => {
  const sidebar = await sidebarWithChannels();
  expect(applyConversationActivityToRow(sidebar, activity({}), "viewer")).toBe(true);
  expect(sidebar.channels.get("general")?.lastMessage).toEqual({
    createdAt: "2026-10-29T08:00:00.000Z",
    preview: "a new line",
    sender: { kind: "user", name: "Grace", mine: false },
  });
});

test("the viewer's own message is marked as theirs, and still written", async () => {
  const sidebar = await sidebarWithChannels();
  applyConversationActivityToRow(sidebar, activity({ senderUserId: "viewer" }), "viewer");
  expect(sidebar.channels.get("general")?.lastMessage?.sender.mine).toBe(true);
});

test("a direct message writes the DM row's time and preview", async () => {
  const sidebar = await sidebarWithChannels();
  expect(
    applyConversationActivityToRow(
      sidebar,
      activity({ conversationId: "dm-grace", kind: "direct", preview: "hi" }),
      "viewer",
    ),
  ).toBe(true);
  const row = sidebar.directs.get("dm-grace");
  expect(row?.lastMessageAt).toBe("2026-10-29T08:00:00.000Z");
  expect(row?.lastMessagePreview).toBe("hi");
});

test("a row the list does not hold is not written, so the caller re-reads that list", async () => {
  const sidebar = await sidebarWithChannels();
  expect(
    applyConversationActivityToRow(sidebar, activity({ conversationId: "closed-chat" }), "viewer"),
  ).toBe(false);
  expect(
    applyConversationActivityToRow(
      sidebar,
      activity({ conversationId: "dm-new", kind: "direct" }),
      "viewer",
    ),
  ).toBe(false);
});
