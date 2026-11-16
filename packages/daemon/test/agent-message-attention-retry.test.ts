import { expect, test } from "bun:test";
import { IMPORTANT_UNREAD_RETRY_DELAYS_MS } from "#src/daemon-runtime/important-unread-notice";
import { delivery } from "./fixtures/attention-delivery";
import { settled, unreadLoop } from "./fixtures/unread-loop";

// A retry is composed when it is written, not copied from the first attempt (task #14, raft's
// decisions in #coforge-backend:#14 seq 48/54/60): it counts what the queue holds at that moment and
// what has arrived since, and it never shows a body the model was already given in full.

test("a notice written after another arrival counts both, not the earlier attempt's snapshot", async () => {
  const { index, loopNotices, clock } = unreadLoop();
  // An attachment means the notice cannot show the whole body, so the message keeps counting after
  // the attempt that mentioned it.
  const first = {
    ...delivery("first"),
    target: "#team",
    sequence: 5,
    mentionsAgent: true,
    attachmentCount: 1,
  };
  await index.receive(first);
  await settled();
  expect(loopNotices).toHaveLength(1);
  expect(loopNotices[0]).toContain("#team 1 new message");
  expect(loopNotices[0]).not.toContain("@frank");
  clock.nowMs += 1_000;
  // Another conversation's message is behind the batch's sequence, and it is still something to
  // say: the notice that follows counts the batch as it stands, not as the first notice saw it.
  await index.receive({
    ...first,
    deliveryId: "delivery-second",
    messageId: "message-second",
    conversationId: "conversation-2",
    target: "@frank",
    sequence: 1,
  });
  await settled();
  expect(loopNotices).toHaveLength(2);
  expect(loopNotices[1]).toContain("#team 1 new message");
  expect(loopNotices[1]).toContain("@frank 1 new message");
  index.clearAgent("agent-1");
});

test("a retry counts the queue at the moment of the attempt, not when the batch was taken in", async () => {
  const { index, reminder, loopNotices, clock, queue } = unreadLoop();
  await index.receive({
    ...delivery("queued-after"),
    target: "#team",
    sequence: 7,
    mentionsAgent: true,
  });
  await settled();
  expect(loopNotices).toHaveLength(1);
  // The Agent is busy, so these wait in the daemon's delivery queue: no notice, but the daemon holds
  // them, and the next attempt is what says so.
  queue.push(
    { ...delivery("held-1"), target: "#team", sequence: 8 },
    { ...delivery("held-2"), target: "#team", sequence: 9 },
  );
  clock.nowMs += IMPORTANT_UNREAD_RETRY_DELAYS_MS[0];
  reminder.flushDue();
  await settled();
  expect(loopNotices).toHaveLength(2);
  expect(loopNotices[1]).toContain("2 held messages");
  index.clearAgent("agent-1");
});

test("a retry does not repeat a body the model has already been shown in full", async () => {
  const { index, reminder, loopNotices, clock } = unreadLoop();
  await index.receive({
    ...delivery("shown", "human", "frank"),
    target: "#team",
    sequence: 5,
    mentionsAgent: true,
    attachmentCount: 0,
    body: "Ship the release today.",
  });
  await settled();
  expect(loopNotices[0]).toContain("@frank: Ship the release today.");
  clock.nowMs += IMPORTANT_UNREAD_RETRY_DELAYS_MS[0];
  reminder.flushDue();
  await settled();
  expect(loopNotices).toHaveLength(2);
  // The body was shown whole, so the retry must not show it again: repeating it would fill the
  // Agent's context with what it already has. What is left is where to look and how many.
  expect(loopNotices[1]).not.toContain("Ship the release today.");
  expect(loopNotices[1]).toContain("Still waiting: #team (1)");
  index.clearAgent("agent-1");
});

test("a notice for a replaced session names only what arrived since", async () => {
  const { index, loopNotices, replaceSession } = unreadLoop();
  const shown = {
    ...delivery("told", "human", "frank"),
    target: "#team",
    sequence: 5,
    mentionsAgent: true,
    attachmentCount: 0,
    body: "Ship the release today.",
  };
  await index.receive(shown);
  await settled();
  expect(loopNotices).toHaveLength(1);
  // The process that was told went away; a new one says what is unread for itself.
  replaceSession();
  await index.receive({
    ...shown,
    deliveryId: "delivery-later",
    messageId: "message-later",
    sequence: 6,
  });
  await settled();
  expect(loopNotices).toHaveLength(2);
  // The batch the old session was told is not repeated to the new one: only what arrived since is
  // news to it, and the recovery of a replaced session covers the rest.
  expect(loopNotices[1]).toContain("#team 1 new message");
  expect(loopNotices[1]).not.toContain("2 new messages");
  index.clearAgent("agent-1");
});
