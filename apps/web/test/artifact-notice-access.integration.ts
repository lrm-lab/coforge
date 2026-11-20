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
  const recoveryIds = async () =>
    (
      await conversations.readAgentRecoveryContext(h.f.workspaceId, h.f.agents.reader)
    ).resumeMessages.map((message) => message.messageId);
  expect(await recoveryIds()).toContain(event.messageId);

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
  expect(await recoveryIds()).not.toContain(event.messageId);
  await h.f.db.conversation.update({ where: { id: homeId }, data: { visibility: "public" } });
  await h.f.db.conversationMember.updateMany({
    where: { conversationId: homeId, agentId: h.f.agents.reader, leftAt: { not: null } },
    data: { leftAt: null },
  });
  const systemMembership = await h.f.db.conversationMember.findFirst({
    where: { conversationId: event.conversationId, agentId: h.f.agents.reader, leftAt: null },
    select: { id: true },
  });
  expect(systemMembership).not.toBeNull();
});

test("a blocked notice does not starve a later readable one in the same conversation", async () => {
  const blockedArtifact = await h.f.make("Blocked gate");
  const visibleArtifact = await h.f.make("Later gate");
  const reader = await h.nameOf(h.f.agents.reader);
  await h.create(blockedArtifact, `First, see @${reader}.`);
  const blockedSent = await h.submit(blockedArtifact);
  if (blockedSent.status !== "sent") throw new Error("not sent");
  await h.create(visibleArtifact, `Second, see @${reader}.`);
  const visibleSent = await h.submit(visibleArtifact);
  if (visibleSent.status !== "sent") throw new Error("not sent");
  const events = await Promise.all(
    [
      [blockedArtifact, blockedSent.reviewId],
      [visibleArtifact, visibleSent.reviewId],
    ].map(([artifact, reviewId]) =>
      h.f.db.systemAgentEvent.findUniqueOrThrow({
        where: {
          source_agentId_externalEventId: {
            source: "system.artifacts",
            agentId: h.f.agents.reader,
            externalEventId: `${artifact}:${reviewId}`,
          },
        },
        select: { messageId: true, conversationId: true },
      }),
    ),
  );
  const [blocked, visible] = events;
  expect(blocked.conversationId).toBe(visible.conversationId);

  await h.f.db.artifact.update({
    where: { id: blockedArtifact },
    data: { deletedAt: new Date() },
  });

  const conversations = new PrismaDirectConversationRepository(h.f.db);
  const pendingIds = () =>
    conversations
      .readPendingAgentDeliveries(h.f.workspaceId, h.f.agents.reader)
      .then((rows) => rows.map((row) => row.messageId));
  const recoveryIds = () =>
    conversations
      .readAgentRecoveryContext(h.f.workspaceId, h.f.agents.reader)
      .then((context) => context.resumeMessages.map((message) => message.messageId));

  expect(await pendingIds()).not.toContain(blocked.messageId);
  expect(await pendingIds()).toContain(visible.messageId);
  expect(await recoveryIds()).not.toContain(blocked.messageId);
  expect(await recoveryIds()).toContain(visible.messageId);
});
