import { expect, test } from "bun:test";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { AgentInputDrain } from "#src/daemon-runtime/agent-input-drain";
import { settleForwardedTaskRead } from "#src/daemon-runtime/agent-history-read";
import { delivery, session } from "./fixtures/attention-delivery";
import { unreadLoop } from "./fixtures/unread-loop";
import { captureDaemonLogs } from "./log-capture";

test("queued seq12 and seq15 can be indexed as consumed without waking for either old preview", async () => {
  const loop = unreadLoop({ cursor: true });
  const target = "#board:#98";
  const conversationId = "task-conversation";
  const task = (sequence: number) => ({
    ...delivery(`task-${sequence}`, "human", "owner"),
    target,
    conversationId,
    sequence,
    body: `task preview sequence ${sequence}`,
    taskDiscussion: true,
  });
  const agentId = task(12).agentId;
  let held = true;
  const runtime = { ...session(), hasLiveTurn: false };
  const drain = new AgentInputDrain({
    runnerHeld: () => held,
    sessionFor: () => runtime,
    launchFor: () => undefined,
    hasCarried: () => false,
    isLaunching: () => false,
    isStopping: () => false,
    deliverMessage: (_id, message) => loop.index.receive(message),
    hasQueuedDeliveries: () => false,
    runStartup: async () => {},
    runPrompt: async () => {},
    recoverAttention: async () => {},
    abandonLaunch: async (_agentId, error) => error,
    publishStartupError: () => {},
    forgetIntroduced: () => {},
    dropMention: () => {},
    tellCarried: async () => {},
    presentKept: async () => {},
  });
  const enqueue = (message: AgentMessageDelivery) =>
    drain.enqueue(agentId, (completion) => ({ kind: "delivery", message, completion }));
  const { records } = await captureDaemonLogs(async () => {
    const pending = [enqueue(task(12)), enqueue(task(15)), enqueue(task(22))];
    settleForwardedTaskRead(
      loop.index,
      agentId,
      { unread: "true" },
      {
        consumptionScope: { agentId, target, conversationId, channelType: "thread" },
        messages: [],
        hasOlder: false,
        hasNewer: false,
        moreUnread: false,
        modelSeenUpToSeq: 21,
      },
    );
    held = false;
    drain.ensure(agentId);
    await Promise.all(pending);
  });
  expect(loop.loopNotices).toHaveLength(1);
  expect(loop.loopNotices[0]).toContain(task(22).body);
  expect(loop.loopNotices[0]).not.toContain(task(12).body);
  expect(loop.loopNotices[0]).not.toContain(task(15).body);
  expect(loop.index.check(agentId)).toMatchObject([
    { target, pendingCount: 1, latestSequence: 22 },
  ]);
  expect(
    records
      .map(({ properties }) => properties)
      .filter(({ event }) => event === "agent.inbox_notice.accepted")
      .map(({ request_id }) => request_id),
  ).toEqual([task(22).requestId]);
});
