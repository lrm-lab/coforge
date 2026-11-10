import { expect, test } from "bun:test";
import { mentionDeliverySetup } from "./helpers/mention-delivery-fixture";

/**
 * A launch's `started` result sends the Agent every pending tracked mention for its launch, the
 * ones already issued for it too: a Daemon that restarted while the launch was still `starting`
 * republishes the same launch, so nothing is issued anew, and it remembers none of them.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

test.skipIf(!connectionString)(
  "a started result sends a mention already issued for the same launch and session",
  async () => {
    const t = await mentionDeliverySetup(connectionString!);
    try {
      const sent = await t.send(`@bob-${t.suffix} still pending`);
      const issued = t.pushTo(sent.deliveries, t.bob.id);
      const scope = {
        workspaceId: t.workspace.id,
        computerId: t.computer.id,
        agentId: t.bob.id,
      };

      // An accepted session issues only what was not issued for it already.
      t.published.length = 0;
      await t.mentions.resendForCurrentSession(scope);
      expect(t.published).toEqual([]);

      await t.mentions.resendForCurrentSession(scope, { includeIssued: true });
      expect(t.published).toEqual([
        expect.objectContaining({
          deliveryId: issued.deliveryId,
          mentionDelivery: issued.mentionDelivery,
        }),
      ]);
      expect(await t.row(sent.id, t.bob.id)).toMatchObject({ mentionOutcome: "pending" });
    } finally {
      await t.cleanup();
    }
  },
);
