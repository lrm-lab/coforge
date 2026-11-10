import { expect, test } from "bun:test";
import { PrismaAgentDeletionStore } from "#src/server/db/repositories/agent-deletion.repositories.server";
import { mentionDeliverySetup } from "./helpers/mention-delivery-fixture";

/**
 * Deleting an Agent settles its pending tracked mentions as not launched in the transaction that
 * marks it deleted: nothing re-issues for a deleted Agent, and a delete never reaches the Daemon
 * as a person's Stop.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

test.skipIf(!connectionString)(
  "deleting an Agent settles its pending mentions not launched and leaves a delivered one",
  async () => {
    const t = await mentionDeliverySetup(connectionString!);
    try {
      const delivered = await t.send(`@bob-${t.suffix} first`);
      const pending = await t.send(`@bob-${t.suffix} second`);
      const other = await t.send(`@carol-${t.suffix} third`);
      const first = t.pushTo(delivered.deliveries, t.bob.id);
      await t.ack(first, first.mentionDelivery);
      expect(await t.row(delivered.id, t.bob.id)).toMatchObject({ mentionOutcome: "delivered" });
      expect(await t.row(pending.id, t.bob.id)).toMatchObject({ mentionOutcome: "pending" });

      const outcome = await new PrismaAgentDeletionStore(t.db).delete({
        agentId: t.bob.id,
        workspaceId: t.workspace.id,
        deletedAt: new Date(),
      });
      expect(outcome.outcome).toBe("deleted");

      const lost = await t.row(pending.id, t.bob.id);
      expect(lost).toMatchObject({
        mentionOutcome: "lost",
        mentionReasonCategory: "not_launched",
        mentionTerminalCode: null,
      });
      expect(lost.mentionSettledAt).toBeInstanceOf(Date);
      expect(await t.row(delivered.id, t.bob.id)).toMatchObject({ mentionOutcome: "delivered" });
      // Another Agent's pending mention is untouched.
      expect(await t.row(other.id, t.carol.id)).toMatchObject({ mentionOutcome: "pending" });
    } finally {
      await t.cleanup();
    }
  },
);
