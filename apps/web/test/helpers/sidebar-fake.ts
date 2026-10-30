import { QueryClient } from "@tanstack/react-query";

import type { ChatSection } from "#src/features/conversations/chat-section.schemas";
import {
  createSidebar,
  sidebarChannelsQuery,
  sidebarDirectsQuery,
  type SidebarApi,
} from "#src/features/conversations/sidebar-collections";

// The Chat sidebar over a fake server, for the tests of its lists and of its sections.

export type Channel = Awaited<ReturnType<SidebarApi["listChannels"]>>["channels"][number];
const channel = (id: string, fields: Partial<Channel> = {}): Channel => ({
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

/** The section reads as the server answers them, at no stream position. */
export const sectionsRead = (sections: ChatSection[]) => ({ streamPositions: {}, sections });
export const orderRead = (order: string[]) => ({ streamPositions: {}, order });

export const sectionApi = {
  list: async () =>
    sectionsRead([
      {
        id: "section-a",
        name: "Project",
        emoji: null,
        collapsed: false,
        sortOrder: 0,
        sortMode: "manual" as const,
        conversationIds: [] as string[],
      },
    ]),
  order: async () => orderRead([]),
  create: async () => ({
    id: "section-new",
    name: "New",
    emoji: null,
    collapsed: false,
    sortOrder: 0,
    sortMode: "manual" as const,
    conversationIds: [] as string[],
  }),
  update: async () => {},
  remove: async () => {},
  reorder: async () => {},
  move: async () => {},
};

/** The sidebar over a fake server. A save is not retried unless `saveRetryDelaysMs` says so. */
export async function sidebarWith(
  overrides: Partial<SidebarApi> = {},
  {
    synced = true,
    saveRetryDelaysMs = [] as readonly number[],
    sleep = undefined as ((ms: number) => Promise<void>) | undefined,
  } = {},
) {
  const saves: string[] = [];
  const server = {
    channels: [channel("general"), channel("random", { unreadCount: 2 })],
    preferences: {
      conversations: [
        {
          conversationId: "dm-helper",
          peer: { kind: "agent" as const, agentId: "helper" },
          muted: false,
          lastMessage: null,
        },
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
      pinned: [{ conversationId: "dm-helper", sortOrder: 0 }],
      hidden: [] as string[],
      streamPositions: {},
    },
    failReads: false,
    channelReads: 0,
  };
  const api: SidebarApi = {
    sections: sectionApi,
    listChannels: async () => {
      server.channelReads += 1;
      if (server.failReads) throw new Error("offline");
      return { streamPositions: {}, channels: server.channels };
    },
    loadDirectPreferences: async () => {
      if (server.failReads) throw new Error("offline");
      return server.preferences;
    },
    loadDirectBadges: async () => ({ viewerId: "viewer", unread: {}, streamPositions: {} }),
    pin: async (target, pinned) => void saves.push(`pin ${JSON.stringify(target)} ${pinned}`),
    setMuted: async (target, muted) => void saves.push(`mute ${JSON.stringify(target)} ${muted}`),
    markUnread: async (target) => void saves.push(`unread ${JSON.stringify(target)}`),
    close: async (target) => void saves.push(`close ${JSON.stringify(target)}`),
    arrange: async () => void saves.push("arrange"),
    ...overrides,
  };
  const queryClient = new QueryClient();
  // As after hydration: the loader has filled both Query keys.
  await queryClient.query(sidebarChannelsQuery("w", api));
  await queryClient.query(sidebarDirectsQuery("w", { api }));
  const sidebar = createSidebar(queryClient, "w", api, { saveRetryDelaysMs, sleep });
  if (synced) await Promise.all([sidebar.channels.preload(), sidebar.directs.preload()]);
  return { sidebar, saves, server, queryClient };
}
