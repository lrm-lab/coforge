import { expect, test } from "bun:test";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { delivery, session } from "./fixtures/attention-delivery";

const agentId = "agent-1";
const target = "#team";
const sender = {
  latestSenderKind: "human" as const,
  latestSenderHandle: "ada",
  latestSenderDescription: "",
};
const original = {
  ...delivery("before-resume"),
  ...sender,
  target,
};
const replay = { ...original, deliveryId: "delivery-replay" };

function fixture() {
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
  );
  const confirm = (resumed: boolean) =>
    index.confirmNoticeContext(agentId, "claude-code", "session-1", resumed);
  return { confirm, index, notices };
}

test("an accepted message with a new delivery ID is deduplicated after confirmed resume", async () => {
  const { confirm, index, notices } = fixture();
  confirm(false);
  await index.receive(original);
  expect(notices).toHaveLength(1);

  index.clearAgent(agentId);
  index.beginNoticeContext(agentId);
  confirm(true);
  expect(await index.recover(agentId, [replay], {})).toEqual(new Set());
  expect(notices).toHaveLength(1);

  const next = { ...delivery("after-resume"), ...sender, target, sequence: 2 };
  expect(await index.recover(agentId, [next], {})).toEqual(new Set([target]));
  expect(notices).toHaveLength(2);
});

test("a replay remains visible before resume is confirmed", async () => {
  const { confirm, index, notices } = fixture();
  confirm(false);
  await index.receive(original);
  index.clearAgent(agentId);
  expect(await index.recover(agentId, [replay], {})).toEqual(new Set([target]));
  expect(notices).toHaveLength(2);
});

test("a cold start reusing the same session ID still announces the message", async () => {
  const { confirm, index, notices } = fixture();
  confirm(false);
  await index.receive(original);
  index.clearAgent(agentId);
  confirm(false);
  expect(await index.recover(agentId, [replay], {})).toEqual(new Set([target]));
  expect(notices).toHaveLength(2);
});

test("an unread summary still reports the messages outside the recovery budget", async () => {
  const { confirm, index, notices } = fixture();
  confirm(false);
  await index.receive(original);
  index.clearAgent(agentId);
  index.beginNoticeContext(agentId);
  confirm(true);
  expect(
    await index.recover(agentId, [replay], { [target]: 2 }, { [target]: original.conversationId }),
  ).toEqual(new Set([target]));
  expect(notices).toHaveLength(2);
  expect(notices[1]).toContain("#team 1 new message");
  expect(notices[1]).not.toContain("#team 2 new messages");
});

test("an unchanged count-only summary remains visible", async () => {
  const { confirm, index, notices } = fixture();
  confirm(false);
  await index.receive(original);
  index.clearAgent(agentId);
  confirm(true);
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(
      await index.recover(agentId, [], { [target]: 1 }, { [target]: original.conversationId }),
    ).toEqual(new Set([target]));
  }
  expect(notices).toHaveLength(3);
});

test("a different daemon has no evidence to suppress recovered messages", async () => {
  const before = fixture();
  before.confirm(false);
  await before.index.receive(original);
  const after = fixture();
  after.confirm(true);
  expect(await after.index.recover(agentId, [replay], {})).toEqual(new Set([target]));
  expect(after.notices).toHaveLength(1);
});

test("a compaction clears accepted notice identities before the next launch", async () => {
  const { confirm, index, notices } = fixture();
  confirm(false);
  await index.receive(original);
  index.resetNoticeContext(agentId);
  index.clearAgent(agentId);
  confirm(true);
  expect(await index.recover(agentId, [replay], {})).toEqual(new Set([target]));
  expect(notices).toHaveLength(2);
});

test("a notice accepted late cannot enter the replacement context", async () => {
  const notices: string[] = [];
  const { resolve, promise } = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let active: ReturnType<typeof session> = {
    ...session(),
    notify: () => {
      entered.resolve();
      return promise;
    },
  };
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => active },
    async () => {},
  );
  index.confirmNoticeContext(agentId, "claude-code", "session-1", false);
  const interrupted = index.receive(original);
  await entered.promise;
  index.clearAgent(agentId);
  index.beginNoticeContext(agentId);
  active = session((notice) => notices.push(notice));
  index.confirmNoticeContext(agentId, "claude-code", "session-1", true);
  resolve();
  await interrupted;
  expect(await index.recover(agentId, [replay], {})).toEqual(new Set([target]));
  expect(notices).toHaveLength(1);
});

test("live replay on the confirmed context only acknowledges the delivery", async () => {
  const notices: string[] = [];
  const acked: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async (ack) => {
      acked.push(ack.deliveryId);
    },
  );
  index.confirmNoticeContext(agentId, "claude-code", "session-1", false);
  await index.receive(original);
  index.clearAgent(agentId);
  index.confirmNoticeContext(agentId, "claude-code", "session-1", true);
  await index.receive(replay);
  expect(notices).toHaveLength(1);
  expect(acked).toEqual([original.deliveryId, replay.deliveryId]);
});
