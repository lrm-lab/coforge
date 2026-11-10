import { expect, test } from "bun:test";
import {
  MentionDeliveryTracker,
  type TrackedMentionDelivery,
} from "#src/daemon-runtime/mention-delivery-tracker";

const AGENT = "agent-a";
const mention = {
  agentId: AGENT,
  deliveryId: "delivery-1",
  messageId: "message-1",
  conversationId: "conversation-1",
  mentionDelivery: { messageId: "message-1", launchId: "l1", sessionId: "s1", computerId: "c1" },
} as unknown as TrackedMentionDelivery;

test("asking whether a pending mention is consumed can settle again, and it is ACKed once", async () => {
  const acked: string[] = [];
  let consumed = false;
  let reentered = false;
  const tracker: MentionDeliveryTracker = new MentionDeliveryTracker("c1", {
    transition: async () => {},
    terminalError: async () => {},
    acknowledge: async (message) => void acked.push(message.deliveryId),
    running: () => ({ launchId: "l1", sessionId: "s1" }),
    // Reading the cursor binds a conversation, which writes it, which settles the Agent's mentions.
    consumed: () => {
      if (consumed && !reentered) {
        reentered = true;
        tracker.settleConsumed(AGENT);
      }
      return consumed;
    },
    told: () => false,
    announce: async () => "told",
    announceBatch: async () => "told",
    busy: () => true,
    blocked: () => undefined,
  });
  await tracker.deliver(mention);
  consumed = true;

  tracker.settleConsumed(AGENT);
  await Promise.resolve();

  expect(acked).toEqual(["delivery-1"]);
});
