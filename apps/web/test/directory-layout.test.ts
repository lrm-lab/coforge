import { expect, test } from "bun:test";

import type { LiveAgent } from "#src/features/agents/workspace-agents-realtime";
import type { DirectoryChannel } from "#src/features/conversations/conversation-directory-rows";
import type { ChatSection } from "#src/features/conversations/chat-section.schemas";
import {
  directEntries,
  directoryLayout,
  recentConversationIds,
} from "#src/features/conversations/directory-layout";
import type { ListedDirect } from "#src/features/conversations/sidebar-rows";

const channel = (id: string, overrides?: Partial<DirectoryChannel>): DirectoryChannel => ({
  id,
  name: id,
  joined: true,
  visibility: "public",
  pinned: false,
  pinSortOrder: null,
  members: [],
  mentioned: false,
  ...overrides,
});
const direct = (
  conversationId: string,
  position: number,
  overrides?: Partial<ListedDirect>,
): ListedDirect => ({
  conversationId,
  position,
  peer: {
    kind: "people",
    userId: `user-${conversationId}`,
    username: conversationId,
    displayName: conversationId,
    avatarUrl: null,
  },
  pinned: false,
  pinSortOrder: null,
  hidden: false,
  unreadCount: 0,
  ...overrides,
});
const section = (sortMode: ChatSection["sortMode"]): ChatSection => ({
  id: "work",
  name: "Work",
  emoji: null,
  collapsed: false,
  sortOrder: 0,
  sortMode,
  conversationIds: ["older", "dm", "none", "newer"],
});

test("a section sorted by Recent orders its channels and DMs by the times it is given", () => {
  const layout = directoryLayout({
    channels: [channel("older"), channel("none"), channel("newer"), channel("elsewhere")],
    agents: [],
    directRows: [direct("dm", 0)],
    sections: [section("recent")],
    lastMessageTimes: new Map([
      ["older", "2026-10-01T00:00:00Z"],
      ["dm", "2026-10-20T00:00:00Z"],
      ["newer", "2026-10-30T00:00:00Z"],
    ]),
  });
  expect(layout.base["custom:work"]).toEqual([
    "channel:newer",
    "direct:dm",
    "channel:older",
    "channel:none",
  ]);
  expect(layout.base.channels).toEqual(["channel:elsewhere"]);
  expect(layout.base.agents).toEqual([]);
});

test("a section kept in its own order needs no times", () => {
  const layout = directoryLayout({
    channels: [channel("older"), channel("none"), channel("newer")],
    agents: [],
    directRows: [direct("dm", 0)],
    sections: [section("manual")],
    lastMessageTimes: new Map(),
  });
  expect(layout.base["custom:work"]).toEqual([
    "channel:older",
    "direct:dm",
    "channel:none",
    "channel:newer",
  ]);
});

test("a DM is an entry named for its peer, the viewer's own marked as theirs, and one with a gone Agent is dropped", () => {
  const withAgent: ListedDirect = {
    ...direct("with-agent", 1),
    peer: { kind: "agent", agentId: "agent-1" },
  };
  const gone: ListedDirect = { ...direct("gone", 2), peer: { kind: "agent", agentId: "agent-2" } };
  const agent: LiveAgent = {
    id: "agent-1",
    name: "scout",
    displayName: "Scout",
    status: { value: "inactive", expiresAt: null },
  };
  const entries = directEntries(
    [direct("someone", 0), withAgent, gone, direct("self", 3)],
    [agent],
    "user-self",
  );
  expect(entries.map(({ conversationId, name, self }) => [conversationId, name, self])).toEqual([
    ["someone", "someone", false],
    ["with-agent", "Scout", false],
    ["self", "self", true],
  ]);
  expect(entries[1]?.agent).toBe(agent);
});

test("pinned section sorts by manual pin order, recent message time, or name", () => {
  const channels = [
    channel("zeta", { pinned: true, pinSortOrder: 0 }),
    channel("alpha", { pinned: true, pinSortOrder: 2 }),
  ];
  const directRows = [direct("beta", 0, { pinned: true, pinSortOrder: 1 })];
  const lastMessageTimes = new Map<string, string | null>([
    ["zeta", "2026-10-01T00:00:00Z"],
    ["beta", "2026-10-03T00:00:00Z"],
    ["alpha", "2026-10-02T00:00:00Z"],
  ]);

  expect(
    directoryLayout({
      channels,
      agents: [],
      directRows,
      sections: [],
      builtInSortModes: { pinned: "manual", channels: "alpha", agents: "recent" },
      lastMessageTimes,
      locale: "en",
    }).base.pinned,
  ).toEqual(["channel:zeta", "direct:beta", "channel:alpha"]);

  expect(
    directoryLayout({
      channels,
      agents: [],
      directRows,
      sections: [],
      builtInSortModes: { pinned: "recent", channels: "alpha", agents: "recent" },
      lastMessageTimes,
      locale: "en",
    }).base.pinned,
  ).toEqual(["direct:beta", "channel:alpha", "channel:zeta"]);

  expect(
    directoryLayout({
      channels,
      agents: [],
      directRows,
      sections: [],
      builtInSortModes: { pinned: "alpha", channels: "alpha", agents: "recent" },
      lastMessageTimes,
      locale: "en",
    }).base.pinned,
  ).toEqual(["channel:alpha", "direct:beta", "channel:zeta"]);
});

test("channels sort by A-Z or Recent while keeping unjoined channels after joined ones", () => {
  const channels = [
    channel("zeta", { joined: true }),
    channel("alpha", { joined: true }),
    channel("unjoined-new", { joined: false }),
    channel("unjoined-a", { joined: false }),
  ];
  const lastMessageTimes = new Map<string, string | null>([
    ["zeta", "2026-10-05T00:00:00Z"],
    ["alpha", "2026-10-01T00:00:00Z"],
    ["unjoined-new", "2026-10-10T00:00:00Z"],
    ["unjoined-a", "2026-10-02T00:00:00Z"],
  ]);

  const byAlpha = directoryLayout({
    channels,
    agents: [],
    directRows: [],
    sections: [],
    builtInSortModes: { pinned: "manual", channels: "alpha", agents: "recent" },
    lastMessageTimes,
    locale: "en",
  });
  expect(byAlpha.base.channels).toEqual([
    "channel:alpha",
    "channel:zeta",
    "channel:unjoined-a",
    "channel:unjoined-new",
  ]);
  expect(byAlpha.natural.channels).toEqual(byAlpha.base.channels);

  const byRecent = directoryLayout({
    channels,
    agents: [],
    directRows: [],
    sections: [],
    builtInSortModes: { pinned: "manual", channels: "recent", agents: "recent" },
    lastMessageTimes,
    locale: "en",
  });
  expect(byRecent.base.channels).toEqual([
    "channel:zeta",
    "channel:alpha",
    "channel:unjoined-new",
    "channel:unjoined-a",
  ]);
  expect(byRecent.natural.channels).toEqual(byRecent.base.channels);
});

test("direct messages sort by Recent or A-Z and keep natural drop order in sync", () => {
  const directRows = [direct("zeta", 0), direct("alpha", 1), direct("beta", 2)];
  const lastMessageTimes = new Map<string, string | null>([
    ["zeta", "2026-10-02T00:00:00Z"],
    ["alpha", null],
    ["beta", "2026-10-05T00:00:00Z"],
  ]);

  const byRecent = directoryLayout({
    channels: [],
    agents: [],
    directRows,
    sections: [],
    builtInSortModes: { pinned: "manual", channels: "alpha", agents: "recent" },
    lastMessageTimes,
    locale: "en",
  });
  expect(byRecent.base.agents).toEqual(["direct:beta", "direct:zeta", "direct:alpha"]);
  expect(byRecent.natural.agents).toEqual(byRecent.base.agents);

  const byAlpha = directoryLayout({
    channels: [],
    agents: [],
    directRows,
    sections: [],
    builtInSortModes: { pinned: "manual", channels: "alpha", agents: "alpha" },
    lastMessageTimes,
    locale: "en",
  });
  expect(byAlpha.base.agents).toEqual(["direct:alpha", "direct:beta", "direct:zeta"]);
  expect(byAlpha.natural.agents).toEqual(byAlpha.base.agents);
});

test("recentConversationIds collects only ids belonging to Recent-sorted sections", () => {
  const channels = [channel("pinned-ch", { pinned: true, pinSortOrder: 0 }), channel("open-ch")];
  const directRows = [
    direct("pinned-dm", 0, { pinned: true, pinSortOrder: 1 }),
    direct("open-dm", 1),
    direct("closed-dm", 2, { hidden: true }),
  ];

  expect(
    recentConversationIds({
      channels,
      directRows,
      sections: [section("manual")],
      builtInSortModes: { pinned: "manual", channels: "alpha", agents: "alpha" },
    }),
  ).toEqual([]);

  expect(
    recentConversationIds({
      channels,
      directRows,
      sections: [section("manual")],
      builtInSortModes: { pinned: "manual", channels: "alpha", agents: "recent" },
    }).sort(),
  ).toEqual(["open-dm", "pinned-dm"]);

  expect(
    recentConversationIds({
      channels,
      directRows,
      sections: [section("recent")],
      builtInSortModes: { pinned: "recent", channels: "recent", agents: "alpha" },
    }).sort(),
  ).toEqual(["dm", "newer", "none", "older", "open-ch", "pinned-ch", "pinned-dm"]);
});

test("joinedChannelsOnly hides unjoined channels from Channels and omits them from Recent subscriptions", () => {
  const channels = [
    channel("zeta", { joined: true }),
    channel("alpha", { joined: true }),
    channel("unjoined-a", { joined: false }),
    channel("unjoined-b", { joined: false }),
  ];
  const lastMessageTimes = new Map<string, string | null>([
    ["zeta", "2026-10-05T00:00:00Z"],
    ["alpha", "2026-10-01T00:00:00Z"],
    ["unjoined-a", "2026-10-10T00:00:00Z"],
  ]);

  const layout = directoryLayout({
    channels,
    agents: [],
    directRows: [],
    sections: [],
    builtInSortModes: { pinned: "manual", channels: "recent", agents: "recent" },
    joinedChannelsOnly: true,
    lastMessageTimes,
    locale: "en",
  });
  expect(layout.base.channels).toEqual(["channel:zeta", "channel:alpha"]);
  expect(layout.natural.channels).toEqual(["channel:zeta", "channel:alpha"]);

  expect(
    recentConversationIds({
      channels,
      directRows: [],
      sections: [],
      builtInSortModes: { pinned: "manual", channels: "recent", agents: "alpha" },
      joinedChannelsOnly: true,
    }).sort(),
  ).toEqual(["alpha", "zeta"]);
});
