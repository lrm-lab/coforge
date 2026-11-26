import { expect, test } from "bun:test";
import { ordinaryDeliveryAlreadySeenExact } from "#src/daemon-runtime/delivery-seen-exact";

test("a choice card event is not treated as already-seen by its card sequence", () => {
  expect(
    ordinaryDeliveryAlreadySeenExact(
      { conversationId: "conversation-1", reason: "choice", target: "@owner", sequence: 5 },
      "agent-1",
      { seenExactSequences: () => [5] },
    ),
  ).toBe(false);
});

test("an expired card event is not treated as already-seen by its card sequence", () => {
  expect(
    ordinaryDeliveryAlreadySeenExact(
      { conversationId: "conversation-1", reason: "expired", target: "#general", sequence: 9 },
      "agent-1",
      { seenExactSequences: () => [9] },
    ),
  ).toBe(false);
});

test("an ordinary delivery with a seen exact sequence is already seen", () => {
  expect(
    ordinaryDeliveryAlreadySeenExact(
      { conversationId: "conversation-1", target: "@owner", sequence: 5 },
      "agent-1",
      {
        seenExactSequences: () => [5],
      },
    ),
  ).toBe(true);
});

test("the fictional card_event reason does not exempt a delivery from seen-exact", () => {
  expect(
    ordinaryDeliveryAlreadySeenExact(
      { conversationId: "conversation-1", reason: "card_event", target: "@owner", sequence: 5 },
      "agent-1",
      { seenExactSequences: () => [5] },
    ),
  ).toBe(true);
});
