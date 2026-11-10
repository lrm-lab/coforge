import { expect, test } from "bun:test";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { AgentDeliveryQueue } from "#src/daemon-runtime/agent-delivery-queue";
import { AgentLaunchCustody } from "#src/daemon-runtime/agent-launch-custody";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { session } from "./fixtures/attention-delivery";

const delivery = (id: string, target: string): AgentMessageDelivery => ({
  protocolMajor: 1,
  requestId: `request-${id}`,
  messageId: `message-${id}`,
  deliveryId: `delivery-${id}`,
  sequence: 1,
  workspaceId: "workspace-1",
  conversationId: `conversation-${target}`,
  agentId: "agent-1",
  body: "body",
  method: "agent:v1:message:deliver",
  target,
});

/** A custody over a real delivery queue that holds `held`, and an attention that records what it
 * was asked to announce (`recover`) and to flush. */
function custody(held: AgentMessageDelivery[]) {
  const deliveryQueue = new AgentDeliveryQueue();
  for (const message of held) deliveryQueue.enqueue("agent-1", message);
  const flushed: string[][] = [];
  const recovered: Array<Record<string, number>> = [];
  const messageAttention = {
    // What the real index announces for these contexts: the targets they name.
    recover: async (
      _: string,
      messages: Array<{ target: string }>,
      summary: Record<string, number>,
    ) => {
      recovered.push(summary);
      return new Set([
        ...messages.map((message) => message.target),
        ...Object.entries(summary).flatMap(([target, count]) => (count > 0 ? [target] : [])),
      ]);
    },
    flush: async (_: string, messages: AgentMessageDelivery[]) => {
      flushed.push(messages.map((message) => message.deliveryId));
    },
  };
  const subject = new AgentLaunchCustody({
    messageAttention,
    deliveryQueue,
    releaseHeldAppItems: () => {},
    releaseFallbackNotices: () => {},
  } as never);
  return { subject, deliveryQueue, flushed, recovered };
}

test("a delivery held for a target the recovery does not name is flushed to the fresh session", async () => {
  const { subject, deliveryQueue, flushed, recovered } = custody([
    delivery("ops", "#ops"),
    delivery("general", "#general"),
  ]);

  await subject.recover("agent-1", { unreadSummary: { "#general": 1 } });

  expect(recovered).toEqual([{ "#general": 1 }]);
  // The summary told of #general; nothing told of #ops, so only that one is presented.
  expect(flushed).toEqual([["delivery-ops"]]);
  expect(deliveryQueue.pending("agent-1")).toEqual([]);
});

test("a delivery held for a target a resume message names is not presented again", async () => {
  const { subject, flushed } = custody([delivery("general", "#general")]);

  await subject.recover("agent-1", {
    resumeMessages: [
      {
        messageId: "message-r",
        deliveryId: "delivery-r",
        conversationId: "conversation-#general",
        sequence: 2,
        target: "#general",
        latestSenderKind: "human",
        latestSenderHandle: "ada",
        latestSenderDescription: "Ada",
        body: "hello",
      },
    ],
  });

  expect(flushed).toEqual([]);
});

test("a summary count of zero names nothing", async () => {
  const { subject, flushed } = custody([delivery("ops", "#ops")]);

  await subject.recover("agent-1", {
    wakeMessage: undefined,
    unreadSummary: { "#ops": 0, "#x": 1 },
  });

  expect(flushed).toEqual([["delivery-ops"]]);
});

test("discarding targets leaves the other held deliveries in order", () => {
  const queue = new AgentDeliveryQueue();
  for (const message of [delivery("a", "#a"), delivery("b", "#b"), delivery("c", "#a")])
    queue.enqueue("agent-1", message);

  const dropped = queue.discardTargets("agent-1", new Set(["#a"]));

  expect(dropped.map((message) => message.deliveryId)).toEqual(["delivery-a", "delivery-c"]);
  expect(queue.pending("agent-1").map((message) => message.deliveryId)).toEqual(["delivery-b"]);
});

test("a delivery newer than a message the Agent already read is still presented", async () => {
  const notices: string[] = [];
  const deliveryQueue = new AgentDeliveryQueue();
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
  );
  const held: AgentMessageDelivery = {
    ...delivery("six", "#general"),
    workspaceId: "workspace-1",
    sequence: 6,
    latestSenderKind: "human",
    latestSenderHandle: "alice",
  };
  deliveryQueue.enqueue("agent-1", held);
  // The custody flushes without waiting; keep the flushes to wait on them.
  const flushing: Promise<void>[] = [];
  const subject = new AgentLaunchCustody({
    messageAttention: {
      recover: (...args: Parameters<typeof index.recover>) => index.recover(...args),
      flush: (...args: Parameters<typeof index.flush>) => {
        const flush = index.flush(...args);
        flushing.push(flush);
        return flush;
      },
    },
    deliveryQueue,
    releaseHeldAppItems: () => {},
    releaseFallbackNotices: () => {},
  } as never);
  // The Agent read #general up to 5; the recovery still names sequence 5, so it announces nothing.
  index.recordModelSeen("agent-1", "#general", 5);

  await subject.recover("agent-1", {
    resumeMessages: [
      {
        messageId: "message-five",
        deliveryId: "delivery-five",
        conversationId: held.conversationId,
        sequence: 5,
        target: "#general",
        latestSenderKind: "human",
        latestSenderHandle: "alice",
        latestSenderDescription: "",
        body: "five",
      },
    ],
  });

  await Promise.all(flushing);
  expect(notices.filter((notice) => notice.includes("#general"))).toHaveLength(1);
  expect(deliveryQueue.pending("agent-1")).toEqual([]);
});
