import { expect, test } from "bun:test";
import { Prisma } from "#src/generated/prisma/client";
import { AgentControlOperations } from "#src/server/agents/agent-control-operations.server";
import type { AgentControlAccess } from "#src/server/agents/agent-control-access.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { mentionDeliverySetup } from "./helpers/mention-delivery-fixture";

/**
 * A person's Stop settles the Agent's pending tracked mentions as not launched in the write that
 * records `stoppedAt`: no crash or database error between the two can leave one pending.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

test.skipIf(!connectionString)(
  "the write that records a person's Stop settles the pending mentions, and a lost write settles none",
  async () => {
    const t = await mentionDeliverySetup(connectionString!);
    try {
      const delivered = await t.send(`@bob-${t.suffix} first`);
      const pending = await t.send(`@bob-${t.suffix} second`);
      const other = await t.send(`@carol-${t.suffix} third`);
      const first = t.pushTo(delivered.deliveries, t.bob.id);
      await t.ack(first, first.mentionDelivery);

      const store = new PrismaAgentControlStore(t.db);
      const operations = new AgentControlOperations(store, {} as AgentControlAccess);
      const before = (await store.get(t.bob.id))!;

      // A write that loses its compare-and-swap records no Stop and settles nothing.
      await t.db.agent.update({ where: { id: t.bob.id }, data: { controlState: { stale: 1 } } });
      const state = {
        version: 1,
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        workspaceId: t.workspace.id,
        computerId: t.computer.id,
        agentId: t.bob.id,
        provider: "pi",
        epoch: 1,
        action: "stop",
        phase: "stopping",
        configRevision: "revision",
        controlSequence: 0,
        sessionSequence: 0,
      } as const;
      expect(await store.replace(before, state, { stoppedAt: new Date() })).toBe(false);
      expect(await t.row(pending.id, t.bob.id)).toMatchObject({ mentionOutcome: "pending" });
      await t.db.agent.update({ where: { id: t.bob.id }, data: { controlState: Prisma.DbNull } });

      const stoppedAt = new Date();
      await operations.begin(
        (await store.get(t.bob.id))!,
        "stop",
        crypto.randomUUID(),
        1,
        stoppedAt,
      );

      const lost = await t.row(pending.id, t.bob.id);
      expect(lost).toMatchObject({
        mentionOutcome: "lost",
        mentionReasonCategory: "not_launched",
        mentionTerminalCode: null,
      });
      expect(lost.mentionSettledAt).toEqual(stoppedAt);
      expect(await t.row(delivered.id, t.bob.id)).toMatchObject({ mentionOutcome: "delivered" });
      expect(await t.row(other.id, t.carol.id)).toMatchObject({ mentionOutcome: "pending" });
    } finally {
      await t.cleanup();
    }
  },
);
