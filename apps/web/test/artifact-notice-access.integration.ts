import { afterAll, beforeAll, expect, test } from "bun:test";
import { WEB_DRAFT_REVIEW_MARKER } from "#src/server/artifacts/artifact-notice-visibility.server";
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
        externalEventId: `${artifact}:${WEB_DRAFT_REVIEW_MARKER}:${sent.reviewId}`,
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
            externalEventId: `${artifact}:${WEB_DRAFT_REVIEW_MARKER}:${reviewId}`,
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

test("a notice whose artifact row is gone is not handed back", async () => {
  const artifact = await h.f.make("Vanished gate");
  const reader = await h.nameOf(h.f.agents.reader);
  await h.create(artifact, `Vanished gate, see @${reader}.`);
  const sent = await h.submit(artifact);
  if (sent.status !== "sent") throw new Error("not sent");
  const event = await h.f.db.systemAgentEvent.findUniqueOrThrow({
    where: {
      source_agentId_externalEventId: {
        source: "system.artifacts",
        agentId: h.f.agents.reader,
        externalEventId: `${artifact}:${WEB_DRAFT_REVIEW_MARKER}:${sent.reviewId}`,
      },
    },
    select: { id: true, messageId: true },
  });
  const conversations = new PrismaDirectConversationRepository(h.f.db);
  const pendingIds = async () =>
    (await conversations.readPendingAgentDeliveries(h.f.workspaceId, h.f.agents.reader)).map(
      (delivery) => delivery.messageId,
    );
  expect(await pendingIds()).toContain(event.messageId);

  await h.f.db.systemAgentEvent.update({
    where: { id: event.id },
    data: { externalEventId: `${crypto.randomUUID()}:${WEB_DRAFT_REVIEW_MARKER}:${sent.reviewId}` },
  });

  expect(await pendingIds()).not.toContain(event.messageId);
  const recovery = await conversations.readAgentRecoveryContext(h.f.workspaceId, h.f.agents.reader);
  expect(recovery.resumeMessages.map((message) => message.messageId)).not.toContain(
    event.messageId,
  );
});

test("the JavaScript rule and the SQL predicate agree on an artifact whose home is gone", async () => {
  const { agentsReadingArtifact } = await import("#src/server/artifacts/artifact-access.server");
  const { artifactNoticeBlockedMessages } =
    await import("#src/server/artifacts/artifact-notice-visibility.server");
  const artifact = await h.f.make("Divergence gate");
  const reader = await h.nameOf(h.f.agents.reader);
  await h.create(artifact, `Divergence gate, see @${reader}.`);
  const sent = await h.submit(artifact);
  if (sent.status !== "sent") throw new Error("not sent");
  const event = await h.f.db.systemAgentEvent.findUniqueOrThrow({
    where: {
      source_agentId_externalEventId: {
        source: "system.artifacts",
        agentId: h.f.agents.reader,
        externalEventId: `${artifact}:${WEB_DRAFT_REVIEW_MARKER}:${sent.reviewId}`,
      },
    },
    select: { messageId: true },
  });
  await h.f.db.artifact.update({
    where: { id: artifact },
    data: { access: "conversation", homeKey: `conversation:${crypto.randomUUID()}` },
  });
  const row = await h.f.db.artifact.findUniqueOrThrow({
    where: { id: artifact },
    select: { id: true, homeKey: true, access: true, authorAgentId: true, deletedAt: true },
  });
  expect(row.homeKey).toMatch(/^conversation:[0-9a-f-]{36}$/);
  expect(row.authorAgentId).not.toBe(h.f.agents.reader);

  const byRule = await agentsReadingArtifact(h.f.db, h.f.workspaceId, row, [h.f.agents.reader]);
  const blocked = await artifactNoticeBlockedMessages(h.f.db, h.f.workspaceId, h.f.agents.reader, [
    event.messageId,
  ]);
  expect({ rule: byRule.has(h.f.agents.reader), blocked: blocked.has(event.messageId) }).toEqual({
    rule: false,
    blocked: true,
  });
});

test("an event without the web marker keeps its old behaviour", async () => {
  const artifact = await h.f.make("Old key gate");
  const reader = await h.nameOf(h.f.agents.reader);
  await h.create(artifact, `Old key gate, see @${reader}.`);
  const sent = await h.submit(artifact);
  if (sent.status !== "sent") throw new Error("not sent");
  const event = await h.f.db.systemAgentEvent.findUniqueOrThrow({
    where: {
      source_agentId_externalEventId: {
        source: "system.artifacts",
        agentId: h.f.agents.reader,
        externalEventId: `${artifact}:${WEB_DRAFT_REVIEW_MARKER}:${sent.reviewId}`,
      },
    },
    select: { id: true, messageId: true },
  });
  await h.f.db.systemAgentEvent.update({
    where: { id: event.id },
    data: { externalEventId: `${artifact}:${sent.reviewId}` },
  });
  await h.f.db.artifact.update({ where: { id: artifact }, data: { deletedAt: new Date() } });

  const conversations = new PrismaDirectConversationRepository(h.f.db);
  const pendingIds = await conversations
    .readPendingAgentDeliveries(h.f.workspaceId, h.f.agents.reader)
    .then((rows) => rows.map((row) => row.messageId));
  expect(pendingIds).toContain(event.messageId);
});

test("an author still reads its own notice after the home conversation is gone", async () => {
  const { PrismaSystemAgentEventStore } =
    await import("#src/server/db/repositories/system-agent-event.repositories.server");
  const artifact = await h.f.make("Author fallback");
  const row = await h.f.db.artifact.findUniqueOrThrow({
    where: { id: artifact },
    select: { authorAgentId: true },
  });
  await h.f.db.artifact.update({
    where: { id: artifact },
    data: { access: "conversation", homeKey: `conversation:${crypto.randomUUID()}` },
  });
  if (!row.authorAgentId) throw new Error("the fixture artifact has no author");
  const store = new PrismaSystemAgentEventStore(h.f.db);
  const written = await store.write({
    source: "system.artifacts",
    workspaceId: h.f.workspaceId,
    agentId: row.authorAgentId,
    externalEventId: `${artifact}:${WEB_DRAFT_REVIEW_MARKER}:${crypto.randomUUID()}`,
    expiresAt: await store.expiryAfter(600),
    body: "Author fallback notice.",
  });
  if (!written) throw new Error("not written");

  const conversations = new PrismaDirectConversationRepository(h.f.db);
  const pendingIds = await conversations
    .readPendingAgentDeliveries(h.f.workspaceId, row.authorAgentId)
    .then((rows) => rows.map((delivery) => delivery.messageId));
  expect(pendingIds).toContain(written.messageId);
});

test("a home key without the conversation prefix blocks a non-author", async () => {
  const { agentsReadingArtifact } = await import("#src/server/artifacts/artifact-access.server");
  const artifact = await h.f.make("Prefix gate");
  const reader = await h.nameOf(h.f.agents.reader);
  await h.create(artifact, `Prefix gate, see @${reader}.`);
  const sent = await h.submit(artifact);
  if (sent.status !== "sent") throw new Error("not sent");
  const event = await h.f.db.systemAgentEvent.findUniqueOrThrow({
    where: {
      source_agentId_externalEventId: {
        source: "system.artifacts",
        agentId: h.f.agents.reader,
        externalEventId: `${artifact}:${WEB_DRAFT_REVIEW_MARKER}:${sent.reviewId}`,
      },
    },
    select: { messageId: true },
  });
  await h.f.db.artifact.update({
    where: { id: artifact },
    data: { access: "conversation", homeKey: "conversation-gone" },
  });
  const row = await h.f.db.artifact.findUniqueOrThrow({
    where: { id: artifact },
    select: { id: true, homeKey: true, access: true, authorAgentId: true, deletedAt: true },
  });
  expect(row.authorAgentId).not.toBe(h.f.agents.reader);
  const byRule = await agentsReadingArtifact(h.f.db, h.f.workspaceId, row, [h.f.agents.reader]);
  expect(byRule.has(h.f.agents.reader)).toBe(false);
  const conversations = new PrismaDirectConversationRepository(h.f.db);
  const pendingIds = await conversations
    .readPendingAgentDeliveries(h.f.workspaceId, h.f.agents.reader)
    .then((rows) => rows.map((delivery) => delivery.messageId));
  expect(pendingIds).not.toContain(event.messageId);
});

test("one review tells the writer and the reader, and only the writer survives a gone home", async () => {
  const artifact = await h.f.make("Writer and reader");
  const writer = await h.nameOf(h.f.agents.writer);
  const reader = await h.nameOf(h.f.agents.reader);
  await h.create(artifact, `Both, see @${writer} and @${reader}.`);
  const sent = await h.submit(artifact);
  if (sent.status !== "sent") throw new Error("not sent");
  const eventOf = (agentId: string) =>
    h.f.db.systemAgentEvent.findUniqueOrThrow({
      where: {
        source_agentId_externalEventId: {
          source: "system.artifacts",
          agentId,
          externalEventId: `${artifact}:${WEB_DRAFT_REVIEW_MARKER}:${sent.reviewId}`,
        },
      },
      select: { messageId: true },
    });
  const [writerEvent, readerEvent] = await Promise.all([
    eventOf(h.f.agents.writer),
    eventOf(h.f.agents.reader),
  ]);
  const conversations = new PrismaDirectConversationRepository(h.f.db);
  const pendingFor = async (agentId: string) =>
    (await conversations.readPendingAgentDeliveries(h.f.workspaceId, agentId)).map(
      (delivery) => delivery.messageId,
    );
  expect(await pendingFor(h.f.agents.writer)).toContain(writerEvent.messageId);
  expect(await pendingFor(h.f.agents.reader)).toContain(readerEvent.messageId);

  await h.f.db.artifact.update({
    where: { id: artifact },
    data: { access: "conversation", homeKey: `conversation:${crypto.randomUUID()}` },
  });

  expect(await pendingFor(h.f.agents.writer)).toContain(writerEvent.messageId);
  expect(await pendingFor(h.f.agents.reader)).not.toContain(readerEvent.messageId);
});

test("a revocation between selecting the page and loading it drops the notice", async () => {
  const artifact = await h.f.make("Race gate");
  const reader = await h.nameOf(h.f.agents.reader);
  await h.create(artifact, `Race gate, see @${reader}.`);
  const sent = await h.submit(artifact);
  if (sent.status !== "sent") throw new Error("not sent");
  const event = await h.f.db.systemAgentEvent.findUniqueOrThrow({
    where: {
      source_agentId_externalEventId: {
        source: "system.artifacts",
        agentId: h.f.agents.reader,
        externalEventId: `${artifact}:${WEB_DRAFT_REVIEW_MARKER}:${sent.reviewId}`,
      },
    },
    select: { messageId: true },
  });
  let statements = 0;
  const racing = new Proxy(h.f.db, {
    get(target, property, receiver) {
      if (property !== "$queryRaw") return Reflect.get(target, property, receiver);
      return async (...args: unknown[]) => {
        statements += 1;
        if (statements === 2)
          await h.f.db.artifact.update({
            where: { id: artifact },
            data: { deletedAt: new Date() },
          });
        return (target.$queryRaw as (...inner: unknown[]) => Promise<unknown>)(...args);
      };
    },
  }) as typeof h.f.db;

  const pending = await new PrismaDirectConversationRepository(racing).readPendingAgentDeliveries(
    h.f.workspaceId,
    h.f.agents.reader,
  );

  expect(statements).toBeGreaterThanOrEqual(2);
  expect(pending.map((delivery) => delivery.messageId)).not.toContain(event.messageId);
});

test("a revocation while the bodies load keeps the readable rows", async () => {
  const doomed = await h.f.make("Assembly gate one");
  const kept = await h.f.make("Assembly gate two");
  const reader = await h.nameOf(h.f.agents.reader);
  await h.create(doomed, `Assembly gate one, see @${reader}.`);
  await h.create(kept, `Assembly gate two, see @${reader}.`);
  const first = await h.submit(doomed);
  const second = await h.submit(kept);
  if (first.status !== "sent" || second.status !== "sent") throw new Error("not sent");
  const eventOf = (artifactId: string, reviewId: string) =>
    h.f.db.systemAgentEvent.findUniqueOrThrow({
      where: {
        source_agentId_externalEventId: {
          source: "system.artifacts",
          agentId: h.f.agents.reader,
          externalEventId: `${artifactId}:${WEB_DRAFT_REVIEW_MARKER}:${reviewId}`,
        },
      },
      select: { messageId: true },
    });
  const doomedEvent = await eventOf(doomed, first.reviewId);
  const keptEvent = await eventOf(kept, second.reviewId);

  const racing = new Proxy(h.f.db, {
    get(target, property, receiver) {
      if (property !== "agentMessageDelivery") return Reflect.get(target, property, receiver);
      const model = Reflect.get(target, property, receiver) as object;
      return new Proxy(model, {
        get(inner, method, innerReceiver) {
          if (method !== "findMany") return Reflect.get(inner, method, innerReceiver);
          const read = Reflect.get(inner, method, innerReceiver) as (
            ...args: unknown[]
          ) => Promise<unknown>;
          return async (...args: unknown[]) => {
            await h.f.db.artifact.update({
              where: { id: doomed },
              data: { deletedAt: new Date() },
            });
            return read.apply(inner, args);
          };
        },
      });
    },
  }) as typeof h.f.db;

  const pending = await new PrismaDirectConversationRepository(racing).readPendingAgentDeliveries(
    h.f.workspaceId,
    h.f.agents.reader,
  );
  const returned = pending.map((delivery) => delivery.messageId);

  expect(returned).toContain(keptEvent.messageId);
  expect(returned).not.toContain(doomedEvent.messageId);
});
