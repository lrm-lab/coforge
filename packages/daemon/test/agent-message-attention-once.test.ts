import { expect, test } from "bun:test";
import { delivery } from "./fixtures/attention-delivery";
import { unreadLoop } from "./fixtures/unread-loop";

// Room to say something once, and never twice: the tests here count notices rather than read them.

test("an important message is announced exactly once, however often it arrives", async () => {
  // Composed as the daemon composes it: a reliable delivery is the unread loop's to write (task
  // #14), so the count that matters is the one that reaches the Agent's process.
  const { index, notices, loopNotices } = unreadLoop();
  const important = {
    ...delivery("important-1"),
    target: "#team",
    sequence: 1,
    mentionsAgent: true,
  };
  await index.receive(important);
  expect(notices).toHaveLength(1);
  expect(loopNotices).toHaveLength(1);
  // The transport may hand the same message over again; that is not a second thing to say.
  await index.receive(important);
  await index.receive({ ...important });
  expect(notices).toHaveLength(1);
  expect(loopNotices).toHaveLength(1);
  index.clearAgent("agent-1");
});
