import { expect, test } from "bun:test";
import type { MentionDeliveryEnvelope } from "@lrm/coforge-sdk/internal";
import { delivery } from "./fixtures/attention-delivery";
import { unreadLoop } from "./fixtures/unread-loop";

// A delivery can be a tracked @mention and reliable at the same time — being named is what makes it
// reliable in the first place. "The loop is the reliable tier's only writer" is therefore one writer
// per message, not one writer in the daemon: a tracked mention's notice belongs to the mention
// tracker's path, which owns that notice's retries and its terminal report, and the loop must not
// write it as well (task #14, raft seq 93).

const envelope = (id: string): MentionDeliveryEnvelope => ({
  messageId: `message-${id}`,
  launchId: "launch-1",
  sessionId: "session-1",
  computerId: "computer-1",
});

/** The tracked @mention of a message at `sequence`, as the tracker hands it to the notice path. */
const tracked = (id: string, sequence: number) => ({
  ...delivery(id),
  target: "#coforge-backend",
  sequence,
  mentionsAgent: true,
  mentionDelivery: envelope(id),
});

test("a tracked @mention that is also reliable is written once, by the tracker's path", async () => {
  const { index, notices, loopNotices, records } = unreadLoop();
  expect(await index.announce(tracked("tracked", 4))).toBe("told");
  // Exactly one notice reached the Agent's process, ...
  expect(notices).toHaveLength(1);
  // ... and the loop wrote none of it: the tracked writer did.
  expect(loopNotices).toEqual([]);
  // Nor did the loop take the delivery in, so there is no batch of its own to retry it.
  expect(records.size).toBe(0);
  index.clearAgent("agent-1");
});

test("the same delivery without an envelope is the loop's, so the envelope is what decides", async () => {
  const { index, notices, loopNotices } = unreadLoop();
  await index.announce({ ...tracked("plain", 5), mentionDelivery: undefined });
  expect(notices).toHaveLength(1);
  expect(loopNotices).toHaveLength(1);
  index.clearAgent("agent-1");
});
