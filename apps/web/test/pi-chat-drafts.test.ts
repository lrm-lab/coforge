import { expect, test } from "bun:test";

import { createPiChatDrafts } from "#src/features/pi-chat/pi-chat-drafts";

test("an unwritten key reads as an empty draft, the same one each time", () => {
  const drafts = createPiChatDrafts();
  expect(drafts.get("a")).toEqual({ text: "" });
  expect(drafts.get("a")).toBe(drafts.get("b"));
});

test("a draft written under one key leaves every other key as it was", () => {
  const drafts = createPiChatDrafts();
  drafts.set("a", { text: "hello" });
  expect(drafts.get("a")).toEqual({ text: "hello" });
  expect(drafts.get("b")).toEqual({ text: "" });
});

test("a write reaches its key's subscribers and no one else's", () => {
  const drafts = createPiChatDrafts();
  const heard: string[] = [];
  drafts.subscribe("a", () => heard.push("a"));
  drafts.subscribe("b", () => heard.push("b"));
  drafts.set("a", { text: "x" });
  expect(heard).toEqual(["a"]);
});

test("an unsubscribed listener hears nothing more", () => {
  const drafts = createPiChatDrafts();
  let calls = 0;
  const stop = drafts.subscribe("a", () => calls++);
  drafts.set("a", { text: "x" });
  stop();
  drafts.set("a", { text: "y" });
  expect(calls).toBe(1);
});

test("an update builds on the key's current draft", () => {
  const drafts = createPiChatDrafts();
  drafts.set("a", { text: "one", mode: "steer" });
  drafts.update("a", (draft) => ({ ...draft, text: `${draft.text} two` }));
  expect(drafts.get("a")).toEqual({ text: "one two", mode: "steer" });
});

test("clearing a key empties it and tells its subscribers", () => {
  const drafts = createPiChatDrafts();
  let calls = 0;
  drafts.set("a", { text: "x" });
  drafts.subscribe("a", () => calls++);
  drafts.clear("a");
  expect(drafts.get("a")).toEqual({ text: "" });
  expect(calls).toBe(1);
});

test("two stores never share drafts", () => {
  const first = createPiChatDrafts();
  const second = createPiChatDrafts();
  first.set("a", { text: "x" });
  expect(second.get("a")).toEqual({ text: "" });
});
