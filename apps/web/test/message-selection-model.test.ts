import { expect, test } from "bun:test";

import {
  forwardedPreview,
  type ForwardSourceMessage,
} from "#src/features/conversations/message-forward-model";
import {
  MESSAGE_SELECTION_MAX,
  MessageSelectionStore,
  selectedInOrder,
  selectedLinks,
  selectedMarkdown,
  toggleSelected,
} from "#src/features/conversations/message-selection-model";
import type { MessageView } from "#src/features/conversations/message-view";

function entry(
  id: string,
  createdAt: string,
  plainBody: string,
  senderName = "Ada",
): ForwardSourceMessage {
  return {
    message: {
      id,
      createdAt,
      senderName,
      senderHandle: senderName.toLowerCase(),
      senderKind: "user",
      attachments: [{ id: `${id}-file` }],
    } as unknown as MessageView,
    plainBody,
  };
}

const early = entry("m1", "2026-11-05T15:30:00.000Z", "first", "Frank");
const late = entry("m2", "2026-11-05T15:31:00.000Z", "second", "Dax");

test("picking starts select mode, a second pick unpicks, and another conversation starts over", () => {
  const one = toggleSelected(null, "c1", late).state;
  expect([...one.picked.keys()]).toEqual(["m2"]);
  const two = toggleSelected(one, "c1", early).state;
  expect([...two.picked.keys()]).toEqual(["m2", "m1"]);
  expect([...toggleSelected(two, "c1", late).state.picked.keys()]).toEqual(["m1"]);
  const elsewhere = toggleSelected(two, "c2", early).state;
  expect(elsewhere.conversationId).toBe("c2");
  expect([...elsewhere.picked.keys()]).toEqual(["m1"]);
});

test("a pick past the limit changes nothing and says so", () => {
  let state = toggleSelected(null, "c1", entry("m0", "2026-11-05T00:00:00.000Z", "x")).state;
  for (let at = 1; at < MESSAGE_SELECTION_MAX; at++)
    state = toggleSelected(state, "c1", entry(`m${at}`, "2026-11-05T00:00:00.000Z", "x")).state;
  const over = toggleSelected(state, "c1", entry("one-more", "2026-11-05T00:00:00.000Z", "x"));
  expect(over.full).toBe(true);
  expect(over.state.picked.size).toBe(MESSAGE_SELECTION_MAX);
});

test("links and Markdown read the picks oldest first, whatever order they were picked in", () => {
  const state = toggleSelected(toggleSelected(null, "c1", late).state, "c1", early).state;
  const ordered = selectedInOrder(state);
  expect(ordered.map(({ message }) => message.id)).toEqual(["m1", "m2"]);
  expect(selectedLinks(ordered, (id) => `https://app/x?message=${id}`)).toBe(
    "https://app/x?message=m1\nhttps://app/x?message=m2",
  );
  expect(selectedMarkdown(ordered)).toBe("**Frank**: first\n\n**Dax**: second");
});

test("the dialog previews one original as before and several each with its own attachments", () => {
  const where = { conversationId: "c1", conversationName: "design" };
  const [single] = forwardedPreview({ ...where, messages: [early] });
  expect(single).not.toHaveProperty("attachmentIds");
  expect(
    forwardedPreview({ ...where, messages: [early, late] }).map((one) => one.attachmentIds),
  ).toEqual([["m1-file"], ["m2-file"]]);
});

test("the dialog preview names each original's sender for the card's avatar", () => {
  const where = { conversationId: "c1", conversationName: "design" };
  const person = entry("m3", "2026-11-10T05:00:00.000Z", "hi");
  (person.message as { senderUserId?: string; senderAvatarUrl?: string }).senderUserId = "u1";
  (person.message as { senderAvatarUrl?: string }).senderAvatarUrl = "/a/u1.png";
  const agent = entry("m4", "2026-11-10T05:01:00.000Z", "done", "Scribe");
  Object.assign(agent.message, { senderKind: "agent", senderAgentId: "a1", senderAvatarUrl: null });
  const [one, two] = forwardedPreview({ ...where, messages: [person, agent] });
  expect(one!.sourceSender).toEqual({ kind: "user", id: "u1", avatarUrl: "/a/u1.png" });
  expect(two!.sourceSender).toEqual({ kind: "agent", id: "a1", avatarUrl: null });
});

test("MessageSelectionStore notifies only affected conversation active and message selected listeners", () => {
  const store = new MessageSelectionStore();
  let anyCalls = 0;
  let c1ActiveCalls = 0;
  let c2ActiveCalls = 0;
  let c1StateCalls = 0;
  let m1Calls = 0;
  let m2Calls = 0;
  let m3Calls = 0;

  store.subscribeAnyActive(() => {
    anyCalls += 1;
  });
  store.subscribeConversationActive("c1", () => {
    c1ActiveCalls += 1;
  });
  store.subscribeConversationActive("c2", () => {
    c2ActiveCalls += 1;
  });
  store.subscribeConversationState("c1", () => {
    c1StateCalls += 1;
  });
  store.subscribeMessageSelected("c1", "m1", () => {
    m1Calls += 1;
  });
  store.subscribeMessageSelected("c1", "m2", () => {
    m2Calls += 1;
  });
  store.subscribeMessageSelected("c1", "m3", () => {
    m3Calls += 1;
  });

  expect(store.toggle("c1", early)).toEqual({ full: false });
  expect(store.anyActive).toBe(true);
  expect(store.isConversationActive("c1")).toBe(true);
  expect(store.isConversationActive("c2")).toBe(false);
  expect(store.isMessageSelected("c1", "m1")).toBe(true);
  expect(store.isMessageSelected("c1", "m2")).toBe(false);
  expect({
    anyCalls,
    c1ActiveCalls,
    c2ActiveCalls,
    c1StateCalls,
    m1Calls,
    m2Calls,
    m3Calls,
  }).toEqual({
    anyCalls: 1,
    c1ActiveCalls: 1,
    c2ActiveCalls: 0,
    c1StateCalls: 1,
    m1Calls: 1,
    m2Calls: 0,
    m3Calls: 0,
  });

  expect(store.toggle("c1", late)).toEqual({ full: false });
  expect(store.isMessageSelected("c1", "m2")).toBe(true);
  expect({
    anyCalls,
    c1ActiveCalls,
    c2ActiveCalls,
    c1StateCalls,
    m1Calls,
    m2Calls,
    m3Calls,
  }).toEqual({
    anyCalls: 1,
    c1ActiveCalls: 1,
    c2ActiveCalls: 0,
    c1StateCalls: 2,
    m1Calls: 1,
    m2Calls: 1,
    m3Calls: 0,
  });

  expect(store.toggle("c1", late)).toEqual({ full: false });
  expect(store.isMessageSelected("c1", "m2")).toBe(false);
  expect({
    anyCalls,
    c1ActiveCalls,
    c2ActiveCalls,
    c1StateCalls,
    m1Calls,
    m2Calls,
    m3Calls,
  }).toEqual({
    anyCalls: 1,
    c1ActiveCalls: 1,
    c2ActiveCalls: 0,
    c1StateCalls: 3,
    m1Calls: 1,
    m2Calls: 2,
    m3Calls: 0,
  });

  expect(store.toggle("c2", late)).toEqual({ full: false });
  expect(store.isConversationActive("c1")).toBe(false);
  expect(store.isConversationActive("c2")).toBe(true);
  expect(store.isMessageSelected("c1", "m1")).toBe(false);
  expect(store.isMessageSelected("c2", "m2")).toBe(true);
  expect({
    anyCalls,
    c1ActiveCalls,
    c2ActiveCalls,
    c1StateCalls,
    m1Calls,
    m2Calls,
    m3Calls,
  }).toEqual({
    anyCalls: 1,
    c1ActiveCalls: 2,
    c2ActiveCalls: 1,
    c1StateCalls: 4,
    m1Calls: 2,
    m2Calls: 2,
    m3Calls: 0,
  });

  store.exit();
  expect(store.anyActive).toBe(false);
  expect(store.stateFor("c2")).toBeNull();
  expect({
    anyCalls,
    c1ActiveCalls,
    c2ActiveCalls,
    c1StateCalls,
    m1Calls,
    m2Calls,
    m3Calls,
  }).toEqual({
    anyCalls: 2,
    c1ActiveCalls: 2,
    c2ActiveCalls: 2,
    c1StateCalls: 4,
    m1Calls: 2,
    m2Calls: 2,
    m3Calls: 0,
  });
});
