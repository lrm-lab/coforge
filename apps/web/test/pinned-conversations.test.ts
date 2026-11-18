import { expect, test } from "bun:test";

import {
  canDropInto,
  moveInDirectory,
  pinsAfterDrag,
  splitPinnedConversations,
  sectionChangeAfterDrag,
  type DirectoryLayout,
} from "#src/features/conversations/pinned-conversations";

const channel = (name: string, pinSortOrder: number | null = null) => ({
  id: name,
  name,
  pinned: pinSortOrder !== null,
  pinSortOrder,
});
const direct = (conversationId: string, pinSortOrder: number | null = null, hidden = false) => ({
  conversationId,
  pinned: pinSortOrder !== null,
  pinSortOrder,
  hidden,
});

test("pinned channels and DMs share one list ordered by pin order, and leave their own sections", () => {
  const split = splitPinnedConversations(
    [channel("general"), channel("ops", 2), channel("eng", 0)],
    [direct("helper", 1), direct("scout")],
  );
  expect(split.pinned.map((entry) => entry.id)).toEqual(["eng", "helper", "ops"]);
  expect(split.pinned.map((entry) => entry.kind)).toEqual(["channel", "direct", "channel"]);
  expect(split.channels.map((entry) => entry.id)).toEqual(["general"]);
  expect(split.directs.map((entry) => entry.conversationId)).toEqual(["scout"]);
});

test("pins with the same order keep channels first, each in the order its own list gives", () => {
  const split = splitPinnedConversations(
    [channel("general", 0), channel("ops", 0)],
    [direct("helper", 0)],
  );
  expect(split.pinned.map((entry) => entry.id)).toEqual(["general", "ops", "helper"]);
});

test("with nothing pinned the section is empty and the other sections keep every row", () => {
  const split = splitPinnedConversations([channel("general")], [direct("helper")]);
  expect(split.pinned).toEqual([]);
  expect(split.channels).toHaveLength(1);
  expect(split.directs).toHaveLength(1);
});

test("closing a chat hides it from its own section but never from Pinned", () => {
  const split = splitPinnedConversations(
    [channel("general")],
    [direct("helper", 0, true), direct("scout", null, true), direct("docs")],
  );
  expect(split.pinned.map((entry) => entry.id)).toEqual(["helper"]);
  expect(split.directs.map((entry) => entry.conversationId)).toEqual(["docs"]);
});

const natural = {
  channels: ["channel:general", "channel:ops", "channel:eng"],
  agents: ["direct:helper", "direct:scout"],
};
const layout: DirectoryLayout = {
  pinned: ["channel:ops", "direct:helper"],
  channels: ["channel:general", "channel:eng"],
  agents: ["direct:scout"],
};

test("a row dragged into Pinned lands where it is dropped and leaves its own section", () => {
  const moved = moveInDirectory(layout, natural, "channel:eng", "pinned", 1);
  expect(moved.pinned).toEqual(["channel:ops", "channel:eng", "direct:helper"]);
  expect(moved.channels).toEqual(["channel:general"]);
  expect(pinsAfterDrag(layout, moved)).toEqual({
    pins: [
      { kind: "channel", channelId: "ops" },
      { kind: "channel", channelId: "eng" },
      { kind: "direct", conversationId: "helper" },
    ],
    unpinned: [],
  });
});

test("a pinned row dragged back to its own section is unpinned and returns to its natural place", () => {
  const moved = moveInDirectory(layout, natural, "channel:ops", "channels", 0);
  expect(moved.pinned).toEqual(["direct:helper"]);
  expect(moved.channels).toEqual(["channel:general", "channel:ops", "channel:eng"]);
  expect(pinsAfterDrag(layout, moved)).toEqual({
    pins: [{ kind: "direct", conversationId: "helper" }],
    unpinned: [{ kind: "channel", channelId: "ops" }],
  });
});

test("a row cannot be dropped into the other kind's section", () => {
  expect(canDropInto("channel:ops", "pinned")).toBe(true);
  expect(canDropInto("channel:ops", "channels")).toBe(true);
  expect(canDropInto("channel:ops", "agents")).toBe(false);
  expect(canDropInto("direct:scout", "channels")).toBe(false);
  expect(moveInDirectory(layout, natural, "channel:ops", "agents", 0)).toBe(layout);
  expect(moveInDirectory(layout, natural, "direct:scout", "channels", 0)).toBe(layout);
});

test("pinned rows reorder among themselves; a section's own rows keep their order", () => {
  const reordered = moveInDirectory(layout, natural, "direct:helper", "pinned", 0);
  expect(reordered.pinned).toEqual(["direct:helper", "channel:ops"]);
  expect(pinsAfterDrag(layout, reordered)).toEqual({
    pins: [
      { kind: "direct", conversationId: "helper" },
      { kind: "channel", channelId: "ops" },
    ],
    unpinned: [],
  });

  const unchanged = moveInDirectory(layout, natural, "channel:eng", "channels", 0);
  expect(unchanged.channels).toEqual(["channel:general", "channel:eng"]);
  expect(pinsAfterDrag(layout, unchanged)).toBeNull();
});

test("a move that leaves every row where it is returns the same layout, so nothing re-renders", () => {
  expect(moveInDirectory(layout, natural, "channel:ops", "pinned", 0)).toBe(layout);
  expect(moveInDirectory(layout, natural, "channel:eng", "channels", 0)).toBe(layout);
});

test("a conversation can cross custom groups, reorder inside one, and return to its default group", () => {
  const grouped = {
    ...layout,
    channels: ["channel:general"],
    agents: [],
    "custom:first": ["direct:scout", "channel:eng"],
    "custom:second": [],
  };
  const moved = moveInDirectory(grouped, natural, "direct:scout", "custom:second", 0);
  expect(moved["custom:first"]).toEqual(["channel:eng"]);
  expect(moved["custom:second"]).toEqual(["direct:scout"]);
  expect(sectionChangeAfterDrag(grouped, moved, "direct:scout")).toEqual({
    target: { kind: "direct", conversationId: "scout" },
    sectionId: "second",
    beforeConversationId: null,
  });
  const reordered = moveInDirectory(grouped, natural, "channel:eng", "custom:first", 0);
  expect(reordered["custom:first"]).toEqual(["channel:eng", "direct:scout"]);
  expect(sectionChangeAfterDrag(grouped, reordered, "channel:eng")?.beforeConversationId).toBe(
    "scout",
  );
  const restored = moveInDirectory(moved, natural, "direct:scout", "agents", 0);
  expect(restored.agents).toEqual(["direct:scout"]);
  expect(sectionChangeAfterDrag(moved, restored, "direct:scout")?.sectionId).toBeNull();
  expect(moveInDirectory(grouped, natural, "direct:scout", "channels", 0)).toBe(grouped);
});
