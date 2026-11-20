import { afterAll, beforeAll, expect, test } from "bun:test";
import { WEB_DRAFT_REVIEW_MARKER } from "#src/server/artifacts/artifact-notice-visibility.server";
import { ArtifactCommentDrafts } from "#src/server/artifacts/artifact-comment-drafts.server";
import { draftsHarness, type DraftsHarness } from "./helpers/artifact-drafts-harness";

let h: DraftsHarness;

beforeAll(async () => {
  h = await draftsHarness("atom");
});
afterAll(() => h.f.cleanup());

const quietSignals = { publish: async () => {} };

test("a notice that cannot be stored rolls the review back and keeps the drafts", async () => {
  const artifact = await h.f.make("Atomic send");
  await h.create(artifact, "Keep me.");
  const ids = await h.idsOf(artifact);
  const failing = new ArtifactCommentDrafts(
    h.f.db,
    h.f.blobs,
    async () => true,
    {
      deliver: async () => {},
      stage: async () => {
        throw new Error("notice store down");
      },
    },
    quietSignals,
  );

  const attempt = failing.submit({ ...h.place(artifact), draftIds: ids, clientKey: h.f.key() });
  await expect(attempt).rejects.toThrow();

  expect(await h.f.db.artifactCommentReview.count({ where: { artifactId: artifact } })).toBe(0);
  expect(await h.f.db.artifactComment.count({ where: { artifactId: artifact } })).toBe(0);
  expect(await h.idsOf(artifact)).toEqual(ids);
});

test("two sends with the same key write one review and one notice per recipient", async () => {
  const artifact = await h.f.make("Same key");
  const reader = await h.nameOf(h.f.agents.reader);
  await h.create(artifact, `Same key, @${reader}.`);
  const ids = await h.idsOf(artifact);
  const key = h.f.key();
  const place = h.place(artifact);
  const [first, second] = await Promise.all([
    h.drafts.submit({ ...place, draftIds: ids, clientKey: key }),
    h.drafts.submit({ ...place, draftIds: ids, clientKey: key }),
  ]);
  const reviewIds = [first, second].flatMap((sent) =>
    sent.status === "sent" ? [sent.reviewId] : [],
  );
  expect(new Set(reviewIds).size).toBe(1);
  const reviewId = reviewIds[0]!;
  expect(await h.f.db.artifactCommentReview.count({ where: { artifactId: artifact } })).toBe(1);
  const stored = await h.f.db.systemAgentEvent.findUnique({
    where: {
      source_agentId_externalEventId: {
        source: "system.artifacts",
        agentId: h.f.agents.reader,
        externalEventId: `${artifact}:${WEB_DRAFT_REVIEW_MARKER}:${reviewId}`,
      },
    },
    select: { id: true },
  });
  expect(stored).not.toBeNull();
});

test("a first push that fails leaves the delivery stored for recovery under the same id", async () => {
  const artifact = await h.f.make("Push down");
  const reader = await h.nameOf(h.f.agents.reader);
  await h.create(artifact, `Push down, @${reader}.`);
  const ids = await h.idsOf(artifact);
  const { SystemAgentEvents } =
    await import("#src/server/app-agent-events/system-agent-events.server");
  const { PrismaSystemAgentEventStore } =
    await import("#src/server/db/repositories/system-agent-event.repositories.server");
  const events = new SystemAgentEvents(new PrismaSystemAgentEventStore(h.f.db), async () => {
    throw new Error("push down");
  });
  const port = {
    deliver: async () => {},
    stage: (
      scope: Parameters<typeof events.stage>[0],
      notice: { workspaceId: string; agentId: string; key: string; content: never },
    ) =>
      events.stage(scope, {
        source: "system.artifacts" as const,
        sourceName: "CoForge artifacts",
        workspaceId: notice.workspaceId,
        agentId: notice.agentId,
        key: notice.key,
        message: notice.content,
      }),
  };
  const drafts = new (
    await import("#src/server/artifacts/artifact-comment-drafts.server")
  ).ArtifactCommentDrafts(h.f.db, h.f.blobs, async () => true, port, quietSignals);
  const sent = await drafts.submit({ ...h.place(artifact), draftIds: ids, clientKey: h.f.key() });
  if (sent.status !== "sent") throw new Error("not sent");
  const stored = await h.f.db.systemAgentEvent.findUniqueOrThrow({
    where: {
      source_agentId_externalEventId: {
        source: "system.artifacts",
        agentId: h.f.agents.reader,
        externalEventId: `${artifact}:${WEB_DRAFT_REVIEW_MARKER}:${sent.reviewId}`,
      },
    },
    select: { messageId: true, agentId: true },
  });
  const deliveries = await h.f.db.agentMessageDelivery.findMany({
    where: { messageId: stored.messageId, agentId: stored.agentId },
    select: { deliveryId: true },
  });
  expect(deliveries).toHaveLength(1);
});

test("a duplicate event inside a transaction fails the whole transaction", async () => {
  const { PrismaSystemAgentEventStore } =
    await import("#src/server/db/repositories/system-agent-event.repositories.server");
  const { inTransaction } = await import("#src/server/db/transaction.server");
  const store = new PrismaSystemAgentEventStore(h.f.db);
  const base = {
    source: "system.artifacts" as const,
    workspaceId: h.f.workspaceId,
    agentId: h.f.agents.reader,
    externalEventId: `dup-guard:${h.f.key()}`,
    expiresAt: await store.expiryAfter(60),
    body: "Duplicate guard.",
  };
  await store.write(base);
  expect(await store.write(base)).toBeUndefined();

  const rolledBackEventId = `dup-guard:${h.f.key()}`;
  const advisoryLocks = async (scope: { $queryRaw: typeof h.f.db.$queryRaw }) =>
    (
      await scope.$queryRaw<{ locks: number }[]>`
      SELECT count(*)::int AS locks FROM pg_locks
      WHERE locktype = 'advisory' AND pid = pg_backend_pid()`
    )[0]!.locks;
  const failure = await inTransaction(h.f.db, async (tx) => {
    const before = await advisoryLocks(tx);
    const first = await store.write({ ...base, externalEventId: rolledBackEventId }, tx);
    if (!first) throw new Error("the first staged write found an existing event");
    expect(await advisoryLocks(tx)).toBeGreaterThan(before);
    await store.write(base, tx);
  }).catch((error: unknown) => error);
  const rejection = failure as {
    code?: string;
    meta?: { driverAdapterError?: { cause?: { constraint?: { index?: string } } } };
  };
  expect(rejection.code).toBe("P2002");
  expect(rejection.meta?.driverAdapterError?.cause?.constraint?.index).toBe(
    "system_agent_events_source_agentId_externalEventId_key",
  );

  expect(
    await h.f.db.systemAgentEvent.count({ where: { externalEventId: rolledBackEventId } }),
  ).toBe(0);
  expect(
    await h.f.db.systemAgentEvent.count({ where: { externalEventId: base.externalEventId } }),
  ).toBe(1);
});

async function coldSubmissions(poolMax: number, count: number) {
  const cold = await draftsHarness("cold-review", poolMax);
  const { db, workspaceId, agents } = cold.f;
  const agentId = agents.reader;
  try {
    const reader = await cold.nameOf(agentId);
    const prepared: Parameters<ArtifactCommentDrafts["submit"]>[0][] = [];
    for (let number = 1; number <= count; number++) {
      const artifactId = await cold.f.make(`Cold review ${number}`);
      await cold.create(artifactId, `Cold review for @${reader}.`);
      prepared.push({
        ...cold.place(artifactId),
        draftIds: await cold.idsOf(artifactId),
        clientKey: cold.f.key(),
      });
    }
    const target = {
      workspaceId,
      directKey: `system:system.artifacts|agent:${agentId}`,
    };
    expect(await db.conversation.count({ where: target })).toBe(0);

    const results = await Promise.all(prepared.map((input) => cold.drafts.submit(input)));
    const eventKeys = results.map((sent, index) => {
      if (sent.status !== "sent") throw new Error("cold submit did not send");
      return `${prepared[index]!.artifactId}:${WEB_DRAFT_REVIEW_MARKER}:${sent.reviewId}`;
    });
    const conversation = await db.conversation.findFirstOrThrow({ where: target });
    expect(await db.conversation.count({ where: target })).toBe(1);
    const events = await db.systemAgentEvent.findMany({
      where: { agentId, conversationId: conversation.id, externalEventId: { in: eventKeys } },
      select: { messageId: true },
    });
    expect(events).toHaveLength(count);
    const deliveryIds = [];
    for (const event of events) {
      const deliveries = await db.agentMessageDelivery.findMany({
        where: { agentId, messageId: event.messageId },
        select: { deliveryId: true },
      });
      expect(deliveries).toHaveLength(1);
      deliveryIds.push(deliveries[0]!.deliveryId);
    }
    expect(new Set(deliveryIds).size).toBe(count);
    for (const { artifactId } of prepared) {
      expect(await cold.idsOf(artifactId)).toEqual([]);
      expect(await db.artifactCommentReview.count({ where: { artifactId } })).toBe(1);
      expect(await db.artifactComment.count({ where: { artifactId } })).toBe(1);
    }
  } finally {
    await cold.f.cleanup();
  }
}

test("one pool connection can submit the first review and store its notice", async () => {
  await coldSubmissions(1, 1);
});

test("two simultaneous cold submissions share one system conversation and keep both deliveries", async () => {
  await coldSubmissions(10, 2);
});
