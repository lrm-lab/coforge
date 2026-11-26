import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  agentId,
  newConversation,
  oldConversation,
  readPositionHarness,
  replay,
  taskDelivery,
  taskTarget,
  temporaryReadPositionState,
} from "./fixtures/read-position-acceptance";

let state: ReturnType<typeof temporaryReadPositionState>;
let harness: ReturnType<typeof readPositionHarness>;

beforeEach(() => {
  state = temporaryReadPositionState();
  harness = readPositionHarness(state.path);
});

afterEach(() => {
  harness.close();
  state.remove();
});

const readInA = taskDelivery(oldConversation, 31);
const readInB = taskDelivery(newConversation, 5);
const replayCases = [
  ["delivery", "same process"],
  ["delivery", "after reopen"],
  ["read receipt", "same process"],
  ["read receipt", "after reopen"],
] as const;

test.each(replayCases)(
  "a late old-conversation %s preserves both read positions (%s)",
  async (entryPoint, replayWhen) => {
    await harness.readPage(oldConversation, 31, [readInA]);
    await harness.readPage(newConversation, 5, [readInB]);

    if (entryPoint === "delivery") await harness.attention.receive(readInA);
    else await harness.readPage(oldConversation, 31);
    const writesBeforeReopen = harness.notices.length;

    if (replayWhen === "after reopen") {
      harness.close();
      harness = readPositionHarness(state.path);
    }
    harness.notices.length = 0;
    await harness.attention.receive(replay(readInB));
    const writesAfterCurrentReplay = harness.notices.length;
    await harness.attention.receive(replay(readInA));

    expect({
      writesBeforeReopen,
      writesAfterCurrentReplay,
      writesAfterReplay: harness.notices.length,
      pendingAfterReplay: harness.attention.check(agentId),
    }).toEqual({
      writesBeforeReopen: 0,
      writesAfterCurrentReplay: 0,
      writesAfterReplay: 0,
      pendingAfterReplay: [],
    });
  },
);

test.each(["receipt first", "delivery first"] as const)(
  "an empty page through 31 keeps the unread sequence 32 pending (%s)",
  async (order) => {
    const unread = taskDelivery(oldConversation, 32);
    const deliver = () => harness.attention.receive(unread);
    const applyReceipt = () => harness.readPage(oldConversation, 31);

    if (order === "receipt first") {
      await applyReceipt();
      await deliver();
    } else {
      await deliver();
      expect(harness.attention.pendingMaxSequence(agentId, taskTarget)).toBe(32);
      await applyReceipt();
    }
    await harness.attention.receive(replay(readInA));

    expect(harness.notices).toHaveLength(1);
    expect(harness.attention.pendingMessageCount(agentId, taskTarget)).toBe(1);
    expect(harness.attention.pendingMaxSequence(agentId, taskTarget)).toBe(32);
    expect(harness.attention.hasConsumed(readInA)).toBe(true);
  },
);

test("a recreated conversation receives sequence 5 with no inherited read position", async () => {
  await harness.readPage(oldConversation, 31, [readInA]);
  await harness.attention.receive(readInB);
  expect(harness.notices).toHaveLength(1);
  expect(harness.attention.pendingMaxSequence(agentId, taskTarget)).toBe(5);
});

test("a complete preview at sequence 6 cannot suppress sequence 6 in a recreated conversation", async () => {
  const before = taskDelivery(oldConversation, 6, "Old conversation, complete preview");
  const after = taskDelivery(newConversation, 6, "New conversation, different reply");

  await harness.attention.receive(before);
  expect(harness.notices).toHaveLength(1);
  expect(harness.notices[0]).toContain(before.body);

  await harness.attention.receive(after);
  expect(harness.notices).toHaveLength(2);
  expect(harness.notices[1]).toContain(after.body);
});
