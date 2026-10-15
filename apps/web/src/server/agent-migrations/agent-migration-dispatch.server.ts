import {
  encodeAgentMigrationCancel,
  encodeAgentMigrationLease,
  type AgentMigrationRole,
} from "@lrm/coforge-sdk/internal";
import {
  daemonControlChannel,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import type { AgentMigrationRecord, AgentMigrationState } from "./agent-migrations.server";

/**
 * Telling a migration's two Computers what to do, over their daemon control channels: a transfer
 * lease for the source once the migration is requested (stop the Agent, upload the workspace),
 * one for the target once the upload is complete (download and place it), and a cancel to both.
 * The Computers answer over HTTPS (`agent-migration-daemon-api.server.ts`), never here.
 */

/**
 * How long a migration may go without a step: a 10 GiB bundle with room to retry. A lease runs out
 * this long after the migration's last transition, whenever it is issued, so a Computer's deadline
 * never outlasts the server's (`AgentMigrationOrchestrator.recover`).
 */
export const AGENT_MIGRATION_LEASE_MS = 60 * 60 * 1000;

/**
 * The states in which each role still has work, and so still needs its lease: the target places
 * the workspace, and the source uploads it and then keeps the Agent stopped until the switch.
 */
const LEASED_STATES: Record<AgentMigrationRole, readonly AgentMigrationState[]> = {
  source: ["requested", "source_stopped", "uploaded", "placing"],
  target: ["uploaded", "placing"],
};

const computerOf = (migration: AgentMigrationRecord, role: AgentMigrationRole) =>
  role === "source" ? migration.sourceComputerId : migration.targetComputerId;

const scope = (migration: AgentMigrationRecord, role: AgentMigrationRole) => ({
  protocolMajor: 1,
  requestId: crypto.randomUUID(),
  workspaceId: migration.workspaceId,
  computerId: computerOf(migration, role),
  agentId: migration.agentId,
  migrationId: migration.id,
  generation: migration.generation,
  role,
});

export class AgentMigrationDispatch {
  constructor(private readonly api: Pick<CentrifugoServerApi, "publish">) {}

  /**
   * Leases one role of the migration's current attempt, at the revision it now has, for what is
   * left of its lease; one already run out is not leased at all.
   */
  async lease(migration: AgentMigrationRecord, role: AgentMigrationRole, now = Date.now()) {
    const expiresInMs = migration.updatedAt.getTime() + AGENT_MIGRATION_LEASE_MS - now;
    if (expiresInMs < 1) return;
    await this.api.publish(
      daemonControlChannel(migration.workspaceId, computerOf(migration, role)),
      encodeAgentMigrationLease({
        ...scope(migration, role),
        expectedRevision: migration.revision,
        expiresInMs: Math.min(expiresInMs, AGENT_MIGRATION_LEASE_MS),
      }),
    );
  }

  /**
   * Ends the attempt on both Computers; after the switch the target keeps the Agent. One that
   * cannot be reached still leaves the other told; the first failure is then reported.
   */
  async cancel(migration: AgentMigrationRecord) {
    const sent = await Promise.allSettled(
      (["source", "target"] as const).map((role) =>
        this.api.publish(
          daemonControlChannel(migration.workspaceId, computerOf(migration, role)),
          encodeAgentMigrationCancel({
            ...scope(migration, role),
            switched: !!migration.switchedAt,
          }),
        ),
      ),
    );
    const failed = sent.find((result) => result.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }

  /**
   * Leases a Computer that has just reconnected again, for each of these migrations that still
   * needs work from it: a lease published while it was offline is not kept for it. One that cannot
   * be published does not keep the others from being tried; the first failure is then reported.
   */
  async reissue(migrations: readonly AgentMigrationRecord[], computerId: string, now = Date.now()) {
    const failures: unknown[] = [];
    for (const migration of migrations)
      for (const role of ["source", "target"] as const)
        if (
          computerOf(migration, role) === computerId &&
          LEASED_STATES[role].includes(migration.state)
        ) {
          try {
            await this.lease(migration, role, now);
          } catch (error) {
            failures.push(error);
          }
        }
    if (failures.length) throw failures[0];
  }
}
