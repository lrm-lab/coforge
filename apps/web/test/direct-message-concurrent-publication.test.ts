import { expect, test } from "bun:test";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { withPublishBatch } from "./helpers/fake-centrifugo";
import { MemoryMessageRequestIdempotency } from "./helpers/memory-message-request-idempotency";
import { type RepositoryFake, withUnusedDatabase } from "./helpers/unused-database";

const persisted = {
  id: "message-a",
  deliveryId: "delivery-a",
  body: "Hello",
  createdAt: new Date("2026-08-28T00:00:00Z"),
  workspaceId: "workspace-a",
  computerId: "computer-a",
  agentId: "agent-a",
  sequence: 1,
  threadRootId: null,
  target: "@ada",
  latestSenderKind: "human" as const,
  latestSenderHandle: "ada",
  latestSenderDescription: "",
  attachments: [],
};

function overlapProbe() {
  const state = { pushStarted: false, pushStartedDuringAnnouncement: false, announced: false };
  const centrifugo = withPublishBatch({
    publish: async () => {
      state.pushStarted = true;
    },
  });
  const realtime = {
    async memberChanged() {},
    async messageAvailable() {
      for (let i = 0; i < 40 && !state.pushStarted; i++) await Bun.sleep(5);
      state.pushStartedDuringAnnouncement = state.pushStarted;
      state.announced = true;
    },
  };
  return { state, centrifugo, realtime };
}

const useCaseFor = (
  repository: RepositoryFake,
  centrifugo: ReturnType<typeof overlapProbe>["centrifugo"],
  realtime: ReturnType<typeof overlapProbe>["realtime"],
) =>
  new SendDirectMessage(
    withUnusedDatabase(repository),
    new MemoryMessageRequestIdempotency(),
    centrifugo,
    realtime as never,
  );

const humanSend = {
  idempotencyKey: "request-a",
  workspaceId: "workspace-a",
  conversationId: "conversation-a",
  senderMemberId: "member-a",
  senderUserId: "user-a",
  body: "Hello",
};

const humanRepository = { sendMessage: async () => persisted } as unknown as RepositoryFake;

test("a person's direct message reaches the Agent while the browser announcement is still running", async () => {
  const probe = overlapProbe();
  await useCaseFor(humanRepository, probe.centrifugo, probe.realtime).execute(humanSend);
  expect(probe.state.pushStartedDuringAnnouncement).toBe(true);
  expect(probe.state.announced).toBe(true);
});

test("an Agent's channel message goes to the browser and to its mentioned Agents together", async () => {
  const probe = overlapProbe();
  const repository = {
    getAgentChannel: async () => ({ id: "channel-a" }),
    sendAgentMessage: async () => ({
      ...persisted,
      target: "#general",
      latestSenderKind: "agent" as const,
      latestSenderHandle: "helper",
      mentions: [],
      deliveries: [{ deliveryId: "delivery-b", agentId: "agent-b", computerId: "computer-b" }],
    }),
  } as unknown as RepositoryFake;
  await useCaseFor(repository, probe.centrifugo, probe.realtime).executeFromAgent({
    idempotencyKey: "request-b",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    target: "#general",
    body: "@other hi",
  });
  expect(probe.state.pushStartedDuringAnnouncement).toBe(true);
  expect(probe.state.announced).toBe(true);
});
