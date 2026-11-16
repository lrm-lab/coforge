import { expect, test } from "bun:test";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { delivery, session } from "./fixtures/attention-delivery";

/** Room to say something once, and never twice: the tests here count notices rather than read them. */
const countingIndex = (notices: string[]) =>
  new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
  );

test("an important message is announced exactly once, however often it arrives", async () => {
  const notices: string[] = [];
  const index = countingIndex(notices);
  const important = {
    ...delivery("important-1"),
    target: "#team",
    sequence: 1,
    mentionsAgent: true,
  };
  await index.receive(important);
  expect(notices).toHaveLength(1);
  // The transport may hand the same message over again; that is not a second thing to say.
  await index.receive(important);
  await index.receive({ ...important });
  expect(notices).toHaveLength(1);
  index.clearAgent("agent-1");
});
