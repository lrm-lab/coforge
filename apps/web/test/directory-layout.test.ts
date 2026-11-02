import { expect, test } from "bun:test";

import type { LiveAgent } from "#src/features/agents/workspace-agents-realtime";
import type { DirectoryChannel } from "#src/features/conversations/conversation-directory-rows";
import type { ChatSection } from "#src/features/conversations/chat-section.schemas";
import { directEntries, directoryLayout } from "#src/features/conversations/directory-layout";
import type { ListedDirect } from "#src/features/conversations/sidebar-rows";

/**
 * Task #361: the lists no longer carry each row's last message (it is read per row), so a section
 * sorted by Recent takes its times from `useLastMessageTimes`.
 */
const channel = (id: string): DirectoryChannel => ({
  id,
  name: id,
  joined: true,
  visibility: "public",
  pinned: false,
  pinSortOrder: null,
  members: [],
  mentioned: false,
});
const direct = (conversationId: string, position: number): ListedDirect => ({
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
