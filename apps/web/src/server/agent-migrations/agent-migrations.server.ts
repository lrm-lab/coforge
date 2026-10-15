/**
 * Moving an Agent, with its workspace files, from one Computer to another. This module owns the
 * migration state machine: who may take each step, in which order, and the fencing that makes a
 * retried or late step harmless. Its store owns PostgreSQL persistence only.
 *
 * The happy path is `requested → source_stopped → uploaded → placing → switched → completed`.
 * Before `switched` the source Computer is authoritative: a cancel or a failure leaves the Agent
 * there. The switch moves `Agent.computerId` to the target in the same write; `switched` is the
 * target starting the Agent, and `arrived` completes it. After the switch the target owns the Agent:
 * a cancel only ends the migration and has the Computers clean up, and a failure report is refused,
 * because nothing can move the Agent back.
 *
 * Callers authorize the request: whether the user may manage the Agent, and whether the target's
 * Daemon can take a migration, are checked before `request`.
 */

export type AgentMigrationState =
  | "requested"
  | "source_stopped"
  | "uploaded"
  | "placing"
  | "switched"
  | "completed"
  | "canceled"
  | "failed";

/**
 * A migration in one of these states no longer holds its Agent. The partial unique index
 * `agent_migrations_one_active` spells the same set in SQL; change both together.
 */
export const FINISHED_AGENT_MIGRATION_STATES = ["completed", "canceled", "failed"] as const;

export function isFinishedAgentMigration(state: AgentMigrationState) {
  return (FINISHED_AGENT_MIGRATION_STATES as readonly string[]).includes(state);
}

export type AgentMigrationStep =
  | "source_stopped"
  | "upload_complete"
  | "placement_started"
  | "switch"
  | "arrived";

export type AgentMigrationRecord = {
  id: string;
  workspaceId: string;
  agentId: string;
  sourceComputerId: string;
  targetComputerId: string;
  state: AgentMigrationState;
  /** Bumped by every transition; a step names the revision it read. */
  revision: number;
  /** Bumped when a new transfer attempt replaces the previous one. */
  generation: number;
  /** Set when the target took over the Agent; null while the source still owns it. */
  switchedAt: Date | null;
  /** The last transition; a lease runs out this long after it unless a step renews it. */
  updatedAt: Date;
  errorCode: string | null;
};

export type AgentMigrationTransition = {
  id: string;
  expectedRevision: number;
  to: AgentMigrationState;
  at: Date;
  error?: { code: string; detail: string | null };
  /** Moves the Agent in the same transaction, only while it is still on `fromComputerId`. */
  move?: { agentId: string; fromComputerId: string; toComputerId: string };
  /** The bundle manifest the source sends with `upload_complete`, kept with the transition. */
  manifest?: unknown;
};

export interface AgentMigrationStore {
  /** The Agent's current Computer, or null when no live Agent has this id in the Workspace. */
  agentPlacement(
    workspaceId: string,
    agentId: string,
  ): Promise<{ computerId: string | null } | null>;
  /** Whether a live Computer is linked to the Workspace. */
  workspaceHasComputer(workspaceId: string, computerId: string): Promise<boolean>;
  /** Creates a `requested` migration, or reports that the Agent already has an active one. */
  create(input: {
    workspaceId: string;
    agentId: string;
    sourceComputerId: string;
    targetComputerId: string;
    requestedByUserId: string;
  }): Promise<AgentMigrationRecord | "active_exists">;
  find(id: string): Promise<AgentMigrationRecord | null>;
  /** The Workspace's unfinished migrations this Computer is the source or the target of. */
  activeFor(workspaceId: string, computerId: string): Promise<AgentMigrationRecord[]>;
  /** The bundle manifest stored with `upload_complete`, or null before it. */
  manifest(id: string): Promise<unknown | null>;
  /**
   * Applies a transition only at `expectedRevision`. For a move, `agent_moved` means the Agent had
   * already left the source Computer and `target_unavailable` that the target is no longer a live
   * Computer of the Workspace; either way nothing was written.
   */
  transition(
    input: AgentMigrationTransition,
  ): Promise<AgentMigrationRecord | "stale_revision" | MoveRefusal>;
}

/** Why a switch could not re-home the Agent; the migration then fails with this code. */
export type MoveRefusal = "agent_moved" | "target_unavailable";

/** The Daemon connection a step arrives on: trusted, from its daemon API key. */
export type MigrationParticipant = { workspaceId: string; computerId: string };

export type AgentMigrationRequestRefusal =
  | "agent_not_found"
  | "agent_unplaced"
  | "same_computer"
  | "target_unavailable"
  | "already_migrating";

export type AgentMigrationStepRefusal =
  | "not_found"
  | "wrong_computer"
  | "finished"
  | "stale_generation"
  | "stale_revision"
  | MoveRefusal
  | "invalid_transition"
  | "manifest_required";

export type AgentMigrationRole = "source" | "target";

/** Each step in happy-path order: who sends it and the state it reaches from the previous one. */
const STEPS: Record<AgentMigrationStep, { role: AgentMigrationRole; to: AgentMigrationState }> = {
  source_stopped: { role: "source", to: "source_stopped" },
  upload_complete: { role: "source", to: "uploaded" },
  placement_started: { role: "target", to: "placing" },
  switch: { role: "target", to: "switched" },
  arrived: { role: "target", to: "completed" },
};

const HAPPY_PATH: readonly AgentMigrationState[] = [
  "requested",
  ...Object.values(STEPS).map((step) => step.to),
];

/** Which side of the migration this Computer is, or null when it is neither. */
export function agentMigrationRoleOf(
  migration: AgentMigrationRecord,
  participant: MigrationParticipant,
): AgentMigrationRole | null {
  if (participant.computerId === migration.sourceComputerId) return "source";
  if (participant.computerId === migration.targetComputerId) return "target";
  return null;
}

type Refused<Code> = { status: "refused"; code: Code };

export class AgentMigrations {
  constructor(private readonly store: AgentMigrationStore) {}

  async request(input: {
    workspaceId: string;
    agentId: string;
    targetComputerId: string;
    requestedByUserId: string;
  }): Promise<
    { status: "created"; migration: AgentMigrationRecord } | Refused<AgentMigrationRequestRefusal>
  > {
    const [placement, targetLinked] = await Promise.all([
      this.store.agentPlacement(input.workspaceId, input.agentId),
      this.store.workspaceHasComputer(input.workspaceId, input.targetComputerId),
    ]);
    if (!placement) return { status: "refused", code: "agent_not_found" };
    if (!placement.computerId) return { status: "refused", code: "agent_unplaced" };
    if (placement.computerId === input.targetComputerId)
      return { status: "refused", code: "same_computer" };
    if (!targetLinked) return { status: "refused", code: "target_unavailable" };
    const created = await this.store.create({ ...input, sourceComputerId: placement.computerId });
    if (created === "active_exists") return { status: "refused", code: "already_migrating" };
    return { status: "created", migration: created };
  }

  /** The migration as one of its two Computers may see it, or null for anyone else. */
  async view(participant: MigrationParticipant, migrationId: string) {
    const migration = await this.#find(participant.workspaceId, migrationId);
    return migration && agentMigrationRoleOf(migration, participant) ? migration : null;
  }

  async advance(
    participant: MigrationParticipant,
    input: {
      migrationId: string;
      generation: number;
      expectedRevision: number;
      step: AgentMigrationStep;
      /** Required with `upload_complete`: the bundle's manifest, opaque to this module. */
      manifest?: unknown;
    },
  ): Promise<
    | { status: "advanced" | "already_applied"; migration: AgentMigrationRecord }
    | Refused<AgentMigrationStepRefusal>
  > {
    const migration = await this.#find(participant.workspaceId, input.migrationId);
    if (!migration) return { status: "refused", code: "not_found" };
    const step = STEPS[input.step];
    if (agentMigrationRoleOf(migration, participant) !== step.role)
      return { status: "refused", code: "wrong_computer" };
    if (input.generation !== migration.generation)
      return { status: "refused", code: "stale_generation" };
    // A retry of a step that already landed (its reply was lost) must not read as a failure.
    const reached = HAPPY_PATH.indexOf(step.to);
    if (HAPPY_PATH.indexOf(migration.state) >= reached)
      return { status: "already_applied", migration };
    if (isFinishedAgentMigration(migration.state)) return { status: "refused", code: "finished" };
    if (input.expectedRevision !== migration.revision)
      return { status: "refused", code: "stale_revision" };
    if (migration.state !== HAPPY_PATH[reached - 1])
      return { status: "refused", code: "invalid_transition" };
    if (input.step === "upload_complete" && input.manifest === undefined)
      return { status: "refused", code: "manifest_required" };
    const applied = await this.#apply(migration, {
      to: step.to,
      ...(input.step === "upload_complete" ? { manifest: input.manifest } : {}),
      ...(input.step === "switch"
        ? {
            move: {
              agentId: migration.agentId,
              fromComputerId: migration.sourceComputerId,
              toComputerId: migration.targetComputerId,
            },
          }
        : {}),
    });
    if (applied === "agent_moved" || applied === "target_unavailable") {
      // Nothing was written, so the read revision still holds: end the migration rather than keep
      // holding the Agent's one active migration for a move that can no longer happen.
      await this.#apply(migration, { to: "failed", error: { code: applied, detail: null } });
      return { status: "refused", code: applied };
    }
    return applied === "stale_revision"
      ? { status: "refused", code: applied }
      : { status: "advanced", migration: applied };
  }

  /** A user's cancel, before or after the switch; `switchedAt` says which side keeps the Agent. */
  async cancel(input: {
    workspaceId: string;
    migrationId: string;
  }): Promise<
    | { status: "canceled"; migration: AgentMigrationRecord }
    | Refused<"not_found" | "finished" | "stale_revision">
  > {
    const migration = await this.#find(input.workspaceId, input.migrationId);
    if (!migration) return { status: "refused", code: "not_found" };
    if (isFinishedAgentMigration(migration.state)) return { status: "refused", code: "finished" };
    const applied = await this.#apply(migration, { to: "canceled" });
    return typeof applied === "string"
      ? { status: "refused", code: "stale_revision" }
      : { status: "canceled", migration: applied };
  }

  /** A participant reporting that the transfer cannot continue, before the switch only. */
  async fail(
    participant: MigrationParticipant,
    input: { migrationId: string; generation: number; errorCode: string; errorDetail?: string },
  ): Promise<
    | { status: "failed"; migration: AgentMigrationRecord }
    | Refused<"not_found" | "finished" | "past_switch" | "stale_generation" | "stale_revision">
  > {
    const migration = await this.view(participant, input.migrationId);
    if (!migration) return { status: "refused", code: "not_found" };
    if (isFinishedAgentMigration(migration.state)) return { status: "refused", code: "finished" };
    if (migration.switchedAt) return { status: "refused", code: "past_switch" };
    if (input.generation !== migration.generation)
      return { status: "refused", code: "stale_generation" };
    const applied = await this.#apply(migration, {
      to: "failed",
      error: { code: input.errorCode, detail: input.errorDetail ?? null },
    });
    return typeof applied === "string"
      ? { status: "refused", code: "stale_revision" }
      : { status: "failed", migration: applied };
  }

  /**
   * The server's own failure of an attempt that has not switched: its lease ran out with no step.
   * Refused, with nothing written, once the attempt moved on or ended.
   */
  async expire(migration: AgentMigrationRecord) {
    if (migration.switchedAt || isFinishedAgentMigration(migration.state)) return null;
    const applied = await this.#apply(migration, {
      to: "failed",
      error: { code: "lease_expired", detail: null },
    });
    return typeof applied === "string" ? null : applied;
  }

  /** The unfinished migrations one Computer takes part in, for leasing it again on reconnect. */
  async activeFor(participant: MigrationParticipant) {
    return this.store.activeFor(participant.workspaceId, participant.computerId);
  }

  /** The bundle manifest of a migration a participant has already viewed, or null before upload. */
  async manifest(migration: AgentMigrationRecord) {
    return this.store.manifest(migration.id);
  }

  async #find(workspaceId: string, migrationId: string) {
    const migration = await this.store.find(migrationId);
    return migration && migration.workspaceId === workspaceId ? migration : null;
  }

  /** Compare-and-set at the revision the caller read. */
  #apply(
    migration: AgentMigrationRecord,
    change: Pick<AgentMigrationTransition, "to" | "error" | "move" | "manifest">,
  ) {
    return this.store.transition({
      id: migration.id,
      expectedRevision: migration.revision,
      at: new Date(),
      ...change,
    });
  }
}
