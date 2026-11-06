import { expect, test } from "bun:test";

import {
  forwardedPreview,
  type ForwardSourceMessage,
} from "#src/features/conversations/message-forward-model";
import {
  MESSAGE_SELECTION_MAX,
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
