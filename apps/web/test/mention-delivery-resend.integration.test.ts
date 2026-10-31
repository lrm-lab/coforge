import { expect, test } from "bun:test";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  daemonControlChannel,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { MentionDeliveryReports } from "#src/server/conversations/mention-deliveries.server";
import { AGENT_RECOVERY_MESSAGE_LIMIT } from "#src/server/db/repositories/agent-recovery-row.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { PrismaMentionDeliveryRepository } from "#src/server/db/repositories/mention-delivery.repositories.server";
import { mentionDeliverySetup } from "./helpers/mention-delivery-fixture";

/**
 * Re-sending an Agent's unreceived deliveries (daemon `ready`, an accepted session, a drift or
 * wake answer): the whole backlog goes in one Centrifugo `batch` call, the Workspace's delivery
 * features are read once for it rather than once per delivery, a publication Centrifugo rejects
 * loses its envelope so the next trigger issues it again, and the backlog read is capped
 * oldest-first so a flood beyond `AGENT_RECOVERY_MESSAGE_LIMIT` drains over successive triggers.
 * Drives the real services against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

const setup = () => mentionDeliverySetup(connectionString!);

type Publication = { channel: string; data: Uint8Array };

/** A `publishBatch` that records each batch and answers `results` by index (default: all sent). */
function batchingApi(results?: (index: number) => PromiseSettledResult<void>) {
  const batches: Publication[][] = [];
  const api: Pick<CentrifugoServerApi, "publishBatch"> = {
    publishBatch: async (publications) => {
      batches.push([...publications]);
      return publications.map(
        (_, index) => results?.(index) ?? { status: "fulfilled", value: undefined },
      );
    },
  };
  return { api, batches };
}

/** A client extension that counts every Prisma operation, model-level and raw. */
function countedQueries(db: PrismaClient) {
  const queries: string[] = [];
  const counted = db.$extends({
    query: {
      $allOperations: async ({ model, operation, args, query }) => {
        queries.push(model ? `${model}.${operation}` : operation);
        return query(args);
      },
    },
  });
  return { db: counted as unknown as PrismaClient, queries };
}

test.skipIf(!connectionString)(
  "daemon ready re-sends the whole backlog in one batch, reading delivery features once",
  async () => {
    const t = await setup();
    try {
      // Three unreceived deliveries: two tracked mentions plus an untracked channel message.
      const first = await t.send(`@bob-${t.suffix} one`);
      const second = await t.send(`@bob-${t.suffix} two`);
      const third = await t.send("status update for the channel");
      const unreceived = await t.db.agentMessageDelivery.count({
        where: { agentId: t.bob.id, receivedAt: null },
      });
      expect(unreceived).toBeGreaterThanOrEqual(3);

      const { db, queries } = countedQueries(t.db);
      const { api, batches } = batchingApi();
      let featureReads = 0;
      const reports = new MentionDeliveryReports(
        new PrismaMentionDeliveryRepository(db),
        api,
        new PrismaDirectConversationRepository(db),
        async () => {
          featureReads += 1;
          return { taskConversations: true };
        },
      );
      await reports.resendPending(t.scope(t.bob.id));

      // Before: N deliveries were 2N feature queries and N publish calls. Now: one features
      // read, one batch call, and a constant number of statements however large the backlog.
      expect(featureReads).toBe(1);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(unreceived);
      expect(queries.filter((q) => q === "ConversationMember.findMany")).toHaveLength(1);
      expect(queries.length).toBeLessThanOrEqual(15);

      const channel = daemonControlChannel(t.workspace.id, t.computer.id);
      const sent = batches[0]!.map((publication) => {
        expect(publication.channel).toBe(channel);
        return decodeAgentMessageDelivery(publication.data);
      });
      expect(sent.every((delivery) => delivery.features?.taskConversations === true)).toBe(true);
      // Oldest first, and tracked mentions carry their envelope.
      const resent = [first, second, third].map((message) =>
        sent.find((delivery) => delivery.messageId === message.id)!,
      );
      expect(resent[0]!.mentionDelivery).toMatchObject({ launchId: "launch-bob-1" });
      expect(resent[1]!.mentionDelivery).toMatchObject({ launchId: "launch-bob-1" });
      expect(resent[2]!.mentionDelivery).toBeUndefined();
      // Their place in the batch is the order the repository read them back: oldest first.
      const order = sent
        .filter((delivery) => resent.some((again) => again.deliveryId === delivery.deliveryId))
        .map((delivery) => delivery.messageId);
      expect(order).toEqual([first.id, second.id, third.id]);
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a publication the batch rejects keeps no envelope, the rest keep theirs, and the first rejection still throws",
  async () => {
    const t = await setup();
    try {
      const dropped = await t.send(`@bob-${t.suffix} publish fails`);
      const kept = await t.send(`@bob-${t.suffix} publish succeeds`);
      await t.launch(t.bob.id, "launch-bob-2", "native-bob-2");

      const { api, batches } = batchingApi((index) =>
        index === 0
          ? { status: "rejected", reason: new Error("centrifugo unavailable") }
          : { status: "fulfilled", value: undefined },
      );
      const reports = new MentionDeliveryReports(t.repository, api, t.conversations);
      // Both mentions are issued for the newer launch, then the failure surfaces.
      await expect(reports.resendPending(t.scope(t.bob.id))).rejects.toThrow(
        "centrifugo unavailable",
      );
      expect(batches).toHaveLength(1);

      // The rejected publication's envelope is cleared for the next trigger; the one that went
      // out keeps it.
      expect(await t.row(dropped.id, t.bob.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionLaunchId: null,
      });
      expect(await t.row(kept.id, t.bob.id)).toMatchObject({
        mentionOutcome: "pending",
        mentionLaunchId: "launch-bob-2",
      });

      // The next trigger issues the dropped mention again for the current launch.
      const retry = batchingApi();
      await new MentionDeliveryReports(t.repository, retry.api, t.conversations).resendPending(
        t.scope(t.bob.id),
      );
      const resent = retry.batches
        .flat()
        .map((publication) => decodeAgentMessageDelivery(publication.data));
      expect(resent.find((delivery) => delivery.messageId === dropped.id)).toMatchObject({
        mentionsAgent: true,
        mentionDelivery: { launchId: "launch-bob-2", sessionId: "native-bob-2" },
      });
    } finally {
      await t.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a backlog past AGENT_RECOVERY_MESSAGE_LIMIT re-sends the oldest first; the rest wait for the next trigger",
  async () => {
    const t = await setup();
    try {
      // AGENT_RECOVERY_MESSAGE_LIMIT + 5 unreceived deliveries, older than anything setup made.
      const base = Date.parse("2023-10-01T00:00:00Z");
      const backlog = AGENT_RECOVERY_MESSAGE_LIMIT + 5;
      const rows = Array.from({ length: backlog }, (_, index) => ({
        sequence: 1000 + index,
        createdAt: new Date(base + index * 1000),
      }));
      const messages = await t.db.message.createManyAndReturn({
        data: rows.map((row) => ({
          conversationId: t.team.id,
          workspaceId: t.workspace.id,
          body: `backlog ${row.sequence}`,
          sequence: row.sequence,
          createdAt: row.createdAt,
        })),
        select: { id: true, sequence: true },
      });
      await t.db.agentMessageDelivery.createMany({
        data: messages.map((message) => ({
          messageId: message.id,
          workspaceId: t.workspace.id,
          conversationId: t.team.id,
          agentId: t.bob.id,
          sequence: message.sequence,
          createdAt: rows[message.sequence - 1000]!.createdAt,
        })),
      });

      const { api, batches } = batchingApi();
      await new MentionDeliveryReports(t.repository, api, t.conversations).resendPending(
        t.scope(t.bob.id),
      );

      // One batch of exactly the cap: the oldest deliveries. The newest backlog rows stay
      // `receivedAt: null` for the next trigger.
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(AGENT_RECOVERY_MESSAGE_LIMIT);
      const sequences = batches[0]!.map(
        (publication) => decodeAgentMessageDelivery(publication.data).sequence,
      );
      expect(sequences).toEqual(
        rows.slice(0, AGENT_RECOVERY_MESSAGE_LIMIT).map((row) => row.sequence),
      );
      expect(sequences).not.toContain(1000 + backlog - 1);
      expect(
        await t.db.agentMessageDelivery.count({
          where: { agentId: t.bob.id, receivedAt: null },
        }),
      ).toBeGreaterThanOrEqual(backlog);
    } finally {
      await t.cleanup();
    }
  },
);
