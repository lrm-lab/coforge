import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { draftsHarness, type DraftsHarness } from "./helpers/artifact-drafts-harness";

let h: DraftsHarness;

beforeAll(async () => {
  h = await draftsHarness("access");
});
afterAll(() => h.f.cleanup());

test("a notice stops being readable once the Agent loses the artifact", async () => {
  const artifact = await h.f.make("Access gate");
  const reader = await h.nameOf(h.f.agents.reader);
  await h.create(artifact, `Access gate, see @${reader}.`);
  const sent = await h.submit(artifact);
  if (sent.status !== "sent") throw new Error("not sent");
  const event = await h.f.db.systemAgentEvent.findUniqueOrThrow({
    where: {
      source_agentId_externalEventId: {
        source: "system.artifacts",
        agentId: h.f.agents.reader,
        externalEventId: `${artifact}:${sent.reviewId}`,
      },
    },
    select: { messageId: true, conversationId: true },
  });
  await h.f.db.artifact.update({
    where: { id: artifact },
    data: { access: "conversation" },
  });
  const conversations = new PrismaDirectConversationRepository(h.f.db);
  const pendingIds = async () =>
    (await conversations.readPendingAgentDeliveries(h.f.workspaceId, h.f.agents.reader)).map(
      (delivery) => delivery.messageId,
    );
  expect(await pendingIds()).toContain(event.messageId);

  const home = await h.f.db.artifact.findUniqueOrThrow({
    where: { id: artifact },
    select: { homeKey: true },
  });
  const homeId = home.homeKey!.slice(home.homeKey!.indexOf(":") + 1);
  await h.f.db.conversation.update({
    where: { id: homeId },
    data: { visibility: "private" },
  });
  await h.f.db.conversationMember.updateMany({
    where: { conversationId: homeId, agentId: h.f.agents.reader, leftAt: null },
    data: { leftAt: new Date() },
  });

  expect(await pendingIds()).not.toContain(event.messageId);
  const systemMembership = await h.f.db.conversationMember.findFirst({
    where: { conversationId: event.conversationId, agentId: h.f.agents.reader, leftAt: null },
    select: { id: true },
  });
  expect(systemMembership).not.toBeNull();
});
