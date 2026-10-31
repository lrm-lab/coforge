import { expect, test } from "bun:test";

import { UnreadStore } from "#src/features/conversations/unread-store";

/**
 * Task #361: the Chat page kept its unread counts in one context value, so a message in any
 * conversation rendered every reader again, the open conversation's page included. The store tells
 * each reader only of the count it subscribed to.
 */
function readers(store: UnreadStore, ...conversationIds: string[]) {
  const heard: string[] = [];
  const unsubscribe = conversationIds.map((id) => store.subscribe(id, () => heard.push(id)));
  return { heard, unsubscribe: () => unsubscribe.forEach((stop) => stop()) };
}

test("a count that moves tells its own readers, and no one else", () => {
  const store = new UnreadStore();
  const { heard } = readers(store, "general", "random", "dm");
  store.update((current) => ({ ...current, general: 2 }));
  expect(heard).toEqual(["general"]);
  expect(store.count("general")).toBe(2);
  expect(store.count("random")).toBeUndefined();

  // A change that leaves the counts as they were tells no one.
  heard.length = 0;
  store.update((current) => current);
  store.update((current) => ({ ...current }));
  expect(heard).toEqual([]);
});

test("clearing a badge tells its readers; recording its read boundary alone does not", () => {
  const store = new UnreadStore();
  store.update(() => ({ general: 3 }));
  const { heard } = readers(store, "general", "random");
  store.clear("general", 9);
  expect(heard).toEqual(["general"]);
  expect(store.count("general")).toBeUndefined();

  heard.length = 0;
  // `random` had no badge: only its boundary (`random:seq`) moves.
  store.clear("random", 4);
  expect(heard).toEqual([]);
});

test("a reader that left hears nothing more, while the others still do", () => {
  const store = new UnreadStore();
  const first = readers(store, "general");
  const second = readers(store, "general");
  first.unsubscribe();
  store.update(() => ({ general: 1 }));
  expect(first.heard).toEqual([]);
  expect(second.heard).toEqual(["general"]);
  second.unsubscribe();
  store.update(() => ({ general: 2 }));
  expect(second.heard).toEqual(["general"]);
});

test("a conversation read again after its last reader left is heard again", () => {
  const store = new UnreadStore();
  readers(store, "general").unsubscribe();
  const again = readers(store, "general");
  store.update(() => ({ general: 1 }));
  expect(again.heard).toEqual(["general"]);
});
