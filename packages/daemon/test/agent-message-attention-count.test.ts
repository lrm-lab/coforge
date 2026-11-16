import { expect, test } from "bun:test";
import { delivery } from "./fixtures/attention-delivery";
import { unreadLoop } from "./fixtures/unread-loop";

// How many notices the daemon writes for a fixed set of deliveries, before and after the unread
// loop became the reliable tier's only writer (task #14). Measured on the parent commit
// (c1af686d7) with this same input: every one of the four deliveries was written by the attention
// index, so the process saw 4 notices. The total must not move now that two of them are the loop's;
// only which side writes them, and how often they may be repeated, changes.

const input = () => [
  // Ordinary channel traffic it subscribes to: best effort, one notice, still the index's.
  { ...delivery("channel-1"), target: "#team", sequence: 1 },
  // A direct message is the Agent's own business: reliable, so the loop writes it.
  { ...delivery("dm"), target: "@agent-1", sequence: 2 },
  // Being named in a channel is reliable too.
  { ...delivery("mention"), target: "#team", sequence: 3, mentionsAgent: true },
  // And another ordinary delivery, whose own notice is best effort again.
  { ...delivery("channel-2"), target: "#other", sequence: 4 },
];

test("a fixed input still produces the four notices it produced before the loop wrote any", async () => {
  const { index, notices, loopNotices, records } = unreadLoop();
  for (const message of input()) await index.receive(message);
  expect(notices).toHaveLength(4);
  // Two of the four are the loop's — the direct message and the mention — and the loop is the only
  // writer of that tier: the index wrote the other two and neither reliable one.
  expect(loopNotices).toHaveLength(2);
  expect(records.get("agent-1")).toMatchObject({ key: "seq:3" });
  index.clearAgent("agent-1");
});

test("a reliable delivery is announced once, by the loop, however often it arrives", async () => {
  const { index, notices, loopNotices } = unreadLoop();
  const mention = { ...delivery("once"), target: "#team", sequence: 5, mentionsAgent: true };
  await index.receive(mention);
  // The transport may hand the same message over again: that is not a second thing to say, and the
  // loop's record of the batch must not make it one.
  await index.receive(mention);
  await index.receive({ ...mention });
  expect(notices).toHaveLength(1);
  expect(loopNotices).toHaveLength(1);
  index.clearAgent("agent-1");
});

test("an ordinary delivery is written by the index exactly once, as before", async () => {
  const { index, notices, loopNotices } = unreadLoop();
  const ordinary = { ...delivery("ordinary"), target: "#team", sequence: 6 };
  await index.receive(ordinary);
  await index.receive(ordinary);
  expect(notices).toHaveLength(1);
  expect(loopNotices).toEqual([]);
  index.clearAgent("agent-1");
});
