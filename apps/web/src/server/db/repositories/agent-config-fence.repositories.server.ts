import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { inTransaction } from "#src/server/db/transaction.server";
import { agentControlRevision } from "#src/server/agents/agent-control-types.server";
import { parseAgentRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";
import {
  ControlFenceLostError,
  type ControlFence,
} from "#src/server/agents/agent-config-plan.server";

/**
 * Updates an Agent row. With a `fence` the write is a config push: under the row lock the control
 * state must still be the one the push was planned on, and the write re-fences it, setting only
 * `configRevision` to the hash of the configuration as the row now stores it, so the running
 * launch's reports and wake stay current. The hash is taken from the row after the write because
 * jsonb normalizes key order. Throws `ControlFenceLostError`, with nothing written, when the
 * control state moved. A transaction client joins the caller's transaction; a plain client opens one.
 */
export async function updateAgentRow(
  db: PrismaClient | Prisma.TransactionClient,
  agentId: string,
  data: Prisma.AgentUncheckedUpdateInput,
  fence?: ControlFence,
) {
  if (!fence) return db.agent.update({ where: { id: agentId }, data });
  return inTransaction(db, (tx) => updateUnderFence(tx, agentId, fence, data));
}

async function updateUnderFence(
  tx: Prisma.TransactionClient,
  agentId: string,
  fence: ControlFence,
  data: Prisma.AgentUncheckedUpdateInput,
) {
  const [locked] = await tx.$queryRaw<{ controlState: unknown }[]>`
    SELECT "controlState" FROM agents WHERE id = ${agentId}::uuid FOR UPDATE`;
  if (!locked || !Bun.deepEquals(locked.controlState, fence.controlState, true))
    throw new ControlFenceLostError();
  const row = await tx.agent.update({ where: { id: agentId }, data });
  await tx.agent.update({
    where: { id: agentId },
    data: {
      controlState: {
        ...(locked.controlState as Prisma.JsonObject),
        configRevision: agentControlRevision(parseAgentRuntimeConfig(row.runtimeConfig)),
      },
    },
  });
  return row;
}
