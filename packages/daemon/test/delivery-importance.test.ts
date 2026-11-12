import { expect, test } from "bun:test";
import {
  DELIVERY_IMPORTANCE,
  deliveryImportance,
  type DeliveryImportanceFacts,
} from "#src/daemon-runtime/delivery-importance";

// One rule decides which deliveries are worth telling an Agent about again, and which are sent
// once (task #14). The tiers are checked here against the shapes the server actually sends, so a
// later change to a field's meaning fails a test instead of quietly reclassifying a person's
// mention as channel traffic.

const plain: DeliveryImportanceFacts = { target: "#general" };

test("a named Agent, a direct message, assigned work and a card's answer are reliable", () => {
  for (const facts of [
    { ...plain, mentionsAgent: true },
    { ...plain, nonMemberMention: true },
    { target: "@coforge-runtime" },
    { ...plain, taskExecutionSessionId: "01a1c000-0000-7000-8000-000000000000" },
    // Assigned work and its discussion, as the server's task ref reports it.
    { ...plain, taskDiscussion: true },
    { ...plain, reason: "choice" },
    { ...plain, reason: "expired" },
  ])
    expect(deliveryImportance(facts)).toBe(DELIVERY_IMPORTANCE.RELIABLE);
});

test("channel traffic and maintenance items get one notice", () => {
  for (const facts of [
    plain,
    { target: "#coforge-backend", mentionsAgent: false },
    { reason: "mentioned" },
    { reason: "subscribed" },
    {},
  ])
    expect(deliveryImportance(facts)).toBe(DELIVERY_IMPORTANCE.BEST_EFFORT);
  // A channel name that merely contains an `@` is not a direct message: the target names the
  // Agent only when it starts with one.
  expect(deliveryImportance({ target: "#team@work" })).toBe(DELIVERY_IMPORTANCE.BEST_EFFORT);
  // A task-shaped target alone is not a task: only the server's own task ref makes it one, so a
  // channel thread whose id happens to be digits stays channel traffic.
  expect(deliveryImportance({ target: "#board:#12" })).toBe(DELIVERY_IMPORTANCE.BEST_EFFORT);
  expect(deliveryImportance({ target: "#board:#12", taskDiscussion: false })).toBe(
    DELIVERY_IMPORTANCE.BEST_EFFORT,
  );
});
