import { expect, test } from "bun:test";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";

import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import {
  AgentDeliveryPublisher,
  type AgentDeliveryPush,
} from "#src/server/conversations/agent-delivery.server";

const push = (agentId: string, computerId: string | null): AgentDeliveryPush => ({
  computerId,
  requestId: "request-1",
  conversationId: "conversation-1",
  agentId,
  messageId: "message-1",
  deliveryId: `delivery-${agentId}`,
  sequence: 1,
  createdAtMs: 1_700_000_000_000,
  target: "#general",
  latestSenderKind: "human",
  latestSenderHandle: "ada",
  latestSenderDescription: "",
  body: "hello",
  mentions: [],
});

test("a send to many Agents goes to Centrifugo as one batch, and one failed push leaves the rest delivered", async () => {
  const batches: { channel: string; data: Uint8Array }[][] = [];
  const api: Pick<CentrifugoServerApi, "publishBatch"> = {
    publishBatch: async (publications) => {
      batches.push([...publications]);
      return publications.map((_, index) =>
        index === 1
          ? { status: "rejected", reason: new Error("Centrifugo publish failed (102)") }
          : { status: "fulfilled", value: undefined },
      );
    },
  };

  const results = await new AgentDeliveryPublisher(api).publish("w", [
    push("a1", "c1"),
    push("stopped", null),
    push("a2", "c2"),
    push("a3", "c1"),
  ]);

  expect(batches).toHaveLength(1);
  expect(batches[0]?.map(({ channel }) => channel)).toEqual([
    "daemon:w:c1",
    "daemon:w:c2",
    "daemon:w:c1",
  ]);
  expect(batches[0]?.map(({ data }) => decodeAgentMessageDelivery(data).agentId)).toEqual([
    "a1",
    "a2",
    "a3",
  ]);
  // One result per pushed delivery, in push order; an Agent with no Computer is not pushed.
  expect(results.map(({ status }) => status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
});

test("a push its encoder refuses fails alone, and the rest still go out in one batch", async () => {
  const batches: string[][] = [];
  const api: Pick<CentrifugoServerApi, "publishBatch"> = {
    publishBatch: async (publications) => {
      batches.push(publications.map(({ data }) => decodeAgentMessageDelivery(data).agentId));
      return publications.map(() => ({ status: "fulfilled", value: undefined }));
    },
  };

  const results = await new AgentDeliveryPublisher(api).publish("w", [
    push("a1", "c1"),
    { ...push("invalid", "c1"), sequence: Number.NaN },
    push("a2", "c2"),
  ]);

  expect(batches).toEqual([["a1", "a2"]]);
  expect(results.map(({ status }) => status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  expect((results[1] as PromiseRejectedResult).reason).toEqual(
    new Error("invalid Agent message sequence"),
  );
});
