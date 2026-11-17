import { expect, test } from "bun:test";

import {
  clearedFilters,
  hasActiveFilter,
  messageSearchParams,
  parseScope,
  toggleScope,
  withScope,
  withSender,
} from "#src/features/search/search-filters";

const NOW = new Date("2026-03-10T15:30:00.000Z");

/** A sender that contradicts a Humans-only scope is an Agent, and the other way round. */
test("an Agent sender drops the Humans part of the scope and keeps the rest", () => {
  expect(withSender({ scope: ["mentioned", "humans"] }, { id: "bot", kind: "agent" })).toEqual({
    senderId: "bot",
    scope: ["mentioned"],
  });
  expect(withSender({ scope: ["humans"] }, { id: "bot", kind: "agent" }).scope).toBeUndefined();
  expect(withSender({ scope: ["agents"] }, { id: "bot", kind: "agent" }).scope).toEqual(["agents"]);
  expect(withSender({ scope: ["agents"] }, { id: "ada", kind: "user" }).scope).toBeUndefined();
});

test("choosing no sender clears it and leaves the scope alone", () => {
  expect(withSender({ senderId: "bot", scope: ["agents"] }, undefined)).toEqual({
    senderId: undefined,
    scope: ["agents"],
  });
});

test("a Humans scope drops an Agent sender, and a sender it cannot name", () => {
  expect(withScope({ senderId: "bot" }, ["humans"], "agent")).toEqual({
    senderId: undefined,
    scope: ["humans"],
  });
  // Gone from the Workspace: the kind is unknown, so the sender goes rather than match nothing.
  expect(withScope({ senderId: "gone" }, ["humans"], undefined).senderId).toBeUndefined();
  expect(withScope({ senderId: "ada" }, ["humans"], "user").senderId).toBe("ada");
  // A scope that allows both kinds keeps any sender.
  expect(withScope({ senderId: "gone" }, ["mentioned"], undefined).senderId).toBe("gone");
});

test("scope keeps one order and ignores unknown entries", () => {
  expect(withScope({}, ["humans", "mentioned"], undefined).scope).toEqual(["mentioned", "humans"]);
  expect(parseScope("humans,bogus,mentioned")).toEqual(["mentioned", "humans"]);
  expect(parseScope("bogus")).toBeUndefined();
  expect(parseScope(undefined)).toBeUndefined();
});

test("toggling a scope chip switches between Humans and Agents while preserving @Me", () => {
  const mentionedHumans = toggleScope({ scope: ["mentioned"] }, "humans", undefined);
  expect(mentionedHumans.scope).toEqual(["mentioned", "humans"]);

  const switchedToAgents = toggleScope({ ...mentionedHumans, senderId: "ada" }, "agents", "user");
  expect(switchedToAgents).toEqual({
    senderId: undefined,
    scope: ["mentioned", "agents"],
  });

  const clearedAgents = toggleScope(switchedToAgents, "agents", undefined);
  expect(clearedAgents.scope).toEqual(["mentioned"]);
  expect(toggleScope(clearedAgents, "mentioned", undefined).scope).toBeUndefined();
});

test("filters narrow on their own; the sort order does not", () => {
  expect(hasActiveFilter({ sort: "recent" })).toBe(false);
  expect(hasActiveFilter({ channelId: "c" })).toBe(true);
  expect(hasActiveFilter({ scope: [] })).toBe(false);
  expect(clearedFilters({ channelId: "c", range: "7d", sort: "recent" })).toEqual({
    sort: "recent",
  });
});

test("scope and sender become the server's sender kind and mention filters", () => {
  const humans = messageSearchParams("q", { scope: ["humans"] }, NOW, "UTC");
  expect(humans.senderKind).toBe("user");
  expect(humans.mentionsViewer).toBeUndefined();
  const mentioned = messageSearchParams("q", { scope: ["mentioned"] }, NOW, "UTC");
  expect(mentioned.mentionsViewer).toBe(true);
  expect(mentioned.senderKind).toBeUndefined();
  // Both kinds allowed means no kind filter.
  expect(
    messageSearchParams("q", { scope: ["humans", "agents"] }, NOW, "UTC").senderKind,
  ).toBeUndefined();
  expect(messageSearchParams("q", { senderId: "bot", channelId: "c" }, NOW, "UTC")).toMatchObject({
    senderId: "bot",
    conversationId: "c",
  });
});

test("time ranges: Today starts at the viewer's midnight, 7 and 30 days roll", () => {
  expect(messageSearchParams("q", { range: "7d" }, NOW, "UTC").after).toBe(
    "2026-03-03T15:30:00.000Z",
  );
  expect(messageSearchParams("q", { range: "30d" }, NOW, "UTC").after).toBe(
    "2026-02-08T15:30:00.000Z",
  );
  expect(messageSearchParams("q", { range: "today" }, NOW, "UTC").after).toBe(
    "2026-03-10T00:00:00.000Z",
  );
  expect(messageSearchParams("q", { range: "today" }, NOW, "Asia/Tokyo").after).toBe(
    "2026-03-10T15:00:00.000Z",
  );
  expect(messageSearchParams("q", {}, NOW, "UTC").after).toBeUndefined();
});

test("Recent sorts only a search with a query; filters alone search without one", () => {
  expect(messageSearchParams("q", { sort: "recent" }, NOW, "UTC").sort).toBe("recent");
  expect(messageSearchParams("q", {}, NOW, "UTC").sort).toBe("relevance");
  const alone = messageSearchParams("", { channelId: "c", sort: "recent" }, NOW, "UTC");
  expect(alone.query).toBeUndefined();
  expect(alone.sort).toBe("relevance");
});
