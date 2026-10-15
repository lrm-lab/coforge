import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { hasErrorCode } from "@lrm/coforge-sdk/internal";
import {
  FINISHED_AGENT_MIGRATION_STATES,
  isFinishedAgentMigration,
  type AgentMigrationRecord,
  type AgentMigrationState,
  type AgentMigrationStore,
  type AgentMigrationTransition,
  type MoveRefusal,
} from "#src/server/agent-migrations/agent-migrations.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { moveAgentToComputer } from "#src/server/db/repositories/agent.repositories.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";

const MIGRATION_SELECT = {
  id: true,
  workspaceId: true,
  agentId: true,
  sourceComputerId: true,
  targetComputerId: true,
  state: true,
  revision: true,
  generation: true,
  switchedAt: true,
  updatedAt: true,
  errorCode: true,
} as const;

function toMigrationRecord(
  row: Omit<AgentMigrationRecord, "state"> & { state: string },
): AgentMigrationRecord {
  return { ...row, state: row.state as AgentMigrationState };
}

/** The columns a transition writes, from the state it reaches. */
function transitionColumns({
  to,
  at,
  error,
  manifest,
}: AgentMigrationTransition): Prisma.AgentMigrationUpdateInput {
  return {
    ...(manifest !== undefined ? { manifest: manifest as Prisma.InputJsonValue } : {}),
    state: to,
    revision: { increment: 1 },
    ...(to === "switched" ? { switchedAt: at } : {}),
    ...(isFinishedAgentMigration(to) ? { finishedAt: at } : {}),
    ...(error ? { errorCode: error.code, errorDetail: error.detail } : {}),
  };
}

/** Rolls the switch's transaction back and names why. */
async function liveWorkspaceComputer(
  db: Pick<PrismaClient, "workspaceComputer">,
  workspaceId: string,
  computerId: string,
) {
  const link = await db.workspaceComputer.findFirst({
    where: { workspaceId, computerId, computer: { deletedAt: null } },
    select: { id: true },
  });
  return Boolean(link);
}

class MoveRefused extends Error {
  constructor(readonly code: MoveRefusal) {
    super(code);
  }
}

export class PrismaAgentMigrationStore implements AgentMigrationStore {
  constructor(private readonly db: PrismaClient) {}

  async agentPlacement(workspaceId: string, agentId: string) {
    return this.db.agent.findFirst({
      where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
      select: { computerId: true },
    });
  }

  async workspaceHasComputer(workspaceId: string, computerId: string) {
    return liveWorkspaceComputer(this.db, workspaceId, computerId);
  }

  async create(input: Parameters<AgentMigrationStore["create"]>[0]) {
    try {
      return toMigrationRecord(
        await this.db.agentMigration.create({ data: input, select: MIGRATION_SELECT }),
      );
    } catch (error) {
      // `agent_migrations_one_active`: the Agent already has a migration that has not finished.
      if (isUniqueViolation(error)) return "active_exists" as const;
      throw error;
    }
  }

  async find(id: string) {
    const row = await this.db.agentMigration.findUnique({
      where: { id },
      select: MIGRATION_SELECT,
    });
    return row ? toMigrationRecord(row) : null;
  }

  async activeFor(workspaceId: string, computerId: string) {
    const rows = await this.db.agentMigration.findMany({
      where: {
        workspaceId,
        state: { notIn: [...FINISHED_AGENT_MIGRATION_STATES] },
        OR: [{ sourceComputerId: computerId }, { targetComputerId: computerId }],
      },
      select: MIGRATION_SELECT,
    });
    return rows.map(toMigrationRecord);
  }

  async manifest(id: string) {
    const row = await this.db.agentMigration.findUnique({
      where: { id },
      select: { manifest: true },
    });
    return row?.manifest ?? null;
  }

  async transition(input: AgentMigrationTransition) {
    const { move } = input;
    const update = (db: Pick<PrismaClient, "agentMigration">) =>
      db.agentMigration.update({
        where: { id: input.id, revision: input.expectedRevision },
        data: transitionColumns(input),
        select: MIGRATION_SELECT,
      });
    try {
      if (!move) return toMigrationRecord(await update(this.db));
      return toMigrationRecord(
        await this.db.$transaction(async (tx) => {
          const row = await update(tx);
          if (!(await liveWorkspaceComputer(tx, row.workspaceId, move.toComputerId)))
            throw new MoveRefused("target_unavailable");
          if (!(await moveAgentToComputer(tx, move))) throw new MoveRefused("agent_moved");
          return row;
        }),
      );
    } catch (error) {
      if (error instanceof MoveRefused) return error.code;
      // P2025: no row at that revision — another transition got there first.
      if (hasErrorCode(error, "P2025")) return "stale_revision" as const;
      throw error;
    }
  }
}
