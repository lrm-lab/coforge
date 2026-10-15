import type { AgentRuntimeLock } from "#src/server/agents/agent-runtime-lock.server";
import {
  AGENT_MIGRATION_LEASE_MS,
  type AgentMigrationDispatch,
} from "./agent-migration-dispatch.server";
import type {
  AgentMigrationRecord,
  AgentMigrations,
  MigrationParticipant,
} from "./agent-migrations.server";

/**
 * What the server does around a migration's transfer, so the Agent runs in exactly one place. A
 * request stops the Agent through its control before the source is leased; the switch is followed
 * by a start on the target and `arrived`; an attempt that ends before the switch, failed or
 * canceled, is ended on both Computers and the Agent starts again on the source. An Agent its
 * owner had stopped is never started by any of this. Every start and stop runs under the Agent's
 * runtime lock, as every other control of it does.
 */

type AgentScope = { workspaceId: string; agentId: string };

export type AgentMigrationRuntime = {
  /** Whether the Agent's owner has stopped it; such an Agent is moved, never started. */
  stoppedByUser(agent: AgentScope): Promise<boolean>;
  /** Stops the Agent on the Computer it is placed on, and resolves once that Computer confirms. */
  stop(agent: AgentScope): Promise<void>;
  /** Starts the Agent on the Computer it is placed on now. */
  start(agent: AgentScope): Promise<void>;
};

/** How far past its lease the server waits before expiring a migration a Computer may still be running. */
const EXPIRY_GRACE_MS = 60 * 1000;

const scopeOf = (migration: AgentMigrationRecord): AgentScope => ({
  workspaceId: migration.workspaceId,
  agentId: migration.agentId,
});

export class AgentMigrationOrchestrator {
  constructor(
    private readonly deps: {
      migrations: AgentMigrations;
      dispatch: AgentMigrationDispatch;
      runtime: AgentMigrationRuntime;
      lock: AgentRuntimeLock;
    },
  ) {}

  /** A user's request to move an Agent to another Computer. */
  async request(input: Parameters<AgentMigrations["request"]>[0]) {
    const { migrations, dispatch, runtime, lock } = this.deps;
    const started = await migrations.request(input);
    if (started.status !== "created") return started;
    const agent = scopeOf(started.migration);
    try {
      await lock.run(agent.agentId, async () => {
        if (!(await runtime.stoppedByUser(agent))) await runtime.stop(agent);
      });
    } catch (error) {
      // Nothing has moved yet: end the attempt rather than lease a source still running it. Ending
      // it also starts the Agent again, which supersedes a Stop the source never confirmed and
      // would otherwise replay on reconnect; it can only start once the attempt is over.
      const canceled = await migrations.cancel({
        workspaceId: input.workspaceId,
        migrationId: started.migration.id,
      });
      if (canceled.status === "canceled") await this.ended(canceled.migration);
      throw error;
    }
    await dispatch.lease(started.migration, "source");
    return started;
  }

  /** The source's upload is complete: the target is leased to place it. */
  async uploaded(migration: AgentMigrationRecord) {
    await this.deps.dispatch.lease(migration, "target");
  }

  /** The target's switch landed: the Agent is placed there now, so it starts there. */
  async switched(migration: AgentMigrationRecord) {
    const { migrations, runtime, lock } = this.deps;
    const agent = scopeOf(migration);
    await lock
      .run(agent.agentId, async () => {
        if (!(await runtime.stoppedByUser(agent))) await runtime.start(agent);
      })
      .catch((error: unknown) =>
        // The Agent is on the target either way; its owner can start it there.
        console.warn(
          JSON.stringify({
            event: "agent_migration:target_start_failed",
            migration_id: migration.id,
            agent_id: migration.agentId,
            reason: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    await migrations.advance(
      { workspaceId: migration.workspaceId, computerId: migration.targetComputerId },
      {
        migrationId: migration.id,
        generation: migration.generation,
        expectedRevision: migration.revision,
        step: "arrived",
      },
    );
  }

  /**
   * The attempt ended before finishing: both Computers are told to stop their runs, then the
   * source runs the Agent again. The cancel goes first, on the same channel, so the source has let
   * go of the Agent when the Start reaches it. Safe to repeat, so a daemon retrying its report ends
   * it again; a Computer that cannot be told is reported after the restart, never instead of it.
   */
  async ended(migration: AgentMigrationRecord) {
    const { dispatch, runtime, lock } = this.deps;
    const told = await dispatch.cancel(migration).then(
      () => null,
      (error: unknown) => ({ error }),
    );
    if (!migration.switchedAt) {
      const agent = scopeOf(migration);
      await lock
        .run(agent.agentId, async () => {
          if (!(await runtime.stoppedByUser(agent))) await runtime.start(agent);
        })
        .catch((error: unknown) =>
          console.warn(
            JSON.stringify({
              event: "agent_migration:source_restart_failed",
              migration_id: migration.id,
              agent_id: migration.agentId,
              reason: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
    }
    if (told) throw told.error;
  }

  /** As `ended`, for a migration a report found already ended before its switch. */
  async endedById(participant: MigrationParticipant, migrationId: string) {
    const migration = await this.deps.migrations.view(participant, migrationId);
    if (
      migration &&
      !migration.switchedAt &&
      (migration.state === "failed" || migration.state === "canceled")
    )
      await this.ended(migration);
  }

  /**
   * A Computer of the Workspace has just reconnected. Each of its migrations moves on the way no
   * one else would move it while it was away:
   * - one that has not switched and has had no step for a whole lease, plus a grace for the
   *   Computers' own clocks, fails and ends (their runs give up at the lease itself);
   * - one whose switch landed with no start or `arrived` after it is finished;
   * - every other one leases this Computer again, for the work it still has.
   * One that cannot be moved on does not keep the others from it; the first failure is reported.
   */
  async recover(workspaceId: string, computerId: string, now = Date.now()) {
    const { migrations, dispatch } = this.deps;
    const failures: unknown[] = [];
    const attempt = (work: () => Promise<unknown>) =>
      work().catch((error: unknown) => {
        failures.push(error);
      });
    const leased: AgentMigrationRecord[] = [];
    for (const migration of await migrations.activeFor({ workspaceId, computerId })) {
      const idle = now - migration.updatedAt.getTime();
      if (!migration.switchedAt && idle > AGENT_MIGRATION_LEASE_MS + EXPIRY_GRACE_MS)
        await attempt(async () => {
          const expired = await migrations.expire(migration);
          if (expired) await this.ended(expired);
        });
      else if (migration.state === "switched") await attempt(() => this.switched(migration));
      else leased.push(migration);
    }
    await attempt(() => dispatch.reissue(leased, computerId, now));
    if (failures.length) throw failures[0];
  }

  /** A user's cancel; after the switch the target keeps the Agent. */
  async cancel(input: { workspaceId: string; migrationId: string }) {
    const canceled = await this.deps.migrations.cancel(input);
    if (canceled.status === "canceled") await this.ended(canceled.migration);
    return canceled;
  }
}
