import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import type { AgentMigrationCancel, AgentMigrationLease } from "@lrm/coforge-sdk/internal";
import { commitAgentMigrationBundle, rollBackAgentMigrationPlacement } from "./bundle-commit";
import { AgentMigrationBundleLimitError, writeAgentMigrationBundle } from "./bundle-writer";
import {
  downloadAgentMigrationChunks,
  retryUntilDeadline,
  uploadAgentMigrationChunk,
  type AgentMigrationTransfer,
} from "./chunk-transfer";
import { AgentMigrationCommitError } from "./commit-error";
import { ensureAgentMigrationIgnoreFile } from "./ignore-file";
import {
  AgentMigrationRemoteError,
  type AgentMigrationBucket,
  type AgentMigrationServer,
  type AgentMigrationState,
  type AgentMigrationStep,
} from "./transfer-ports";
import { AgentMigrationTransferError } from "./transfer-error";
import { selectAgentMigrationWorkspace } from "./workspace-selection";

/**
 * This Computer's part in its Agents' migrations, one run per lease. As the source it stops the
 * Agent, reports it stopped, packs and uploads the workspace, then holds the Agent stopped until
 * the server decides the migration. As the target it downloads, verifies and places the workspace,
 * then reports the switch that moves the Agent here, and undoes the placement if the switch did not
 * land. A run is keyed by migration, generation and role, as in the reference Computer, so a lease
 * delivered again joins the run already going and keeps its first deadline. Every server call
 * retries transient failures until that deadline. A failure is reported once, by code only, so no
 * local path or message leaves this Computer; a cancel ends the run without reporting one.
 */

const logger = getLogger(["coforge", "daemon", "agent-migration"]);

/** A lease as it reached this Computer: `deadline` is its expiry in this Computer's clock. */
export type AgentMigrationLeaseGrant = AgentMigrationLease & { deadline: number };

export type AgentMigrationRunnerOptions = {
  /** The server route as the daemon's current connection reaches it. */
  server: () => AgentMigrationServer;
  bucket: AgentMigrationBucket;
  agents: {
    /** Stops the Agent's process on this Computer and resolves once it has exited. */
    stop(agentId: string): Promise<void>;
    isRunning(agentId: string): boolean;
  };
  workspaceDirectory(agentId: string): string;
  /** The daemon's state directory; migration attempts and workspace backups live under it. */
  stateDirectory: string;
  /** How often a source holding its Agent asks whether the migration is decided. */
  outcomePollMs?: number;
};

type Run = { owner: symbol; stop: AbortController; done: Promise<void> };

/** The route's grammar for a failure code. */
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const OUTCOME_POLL_MS = 5_000;
/** The states in which the source must still keep the Agent stopped. */
const UNDECIDED = new Set<AgentMigrationState>([
  "requested",
  "source_stopped",
  "uploaded",
  "placing",
]);

/** One code for the server, whichever layer the failure came from. */
function failureCode(error: unknown): string {
  if (error instanceof AgentMigrationBundleLimitError) return "bundle_too_large";
  const code =
    error instanceof AgentMigrationRemoteError ||
    error instanceof AgentMigrationTransferError ||
    error instanceof AgentMigrationCommitError
      ? error.code
      : "unexpected";
  return ERROR_CODE.test(code) ? code : "unexpected";
}

const runKey = (migrationId: string, generation: number, role: string) =>
  `${migrationId}:${generation}:${role}`;

export class AgentMigrationRunner {
  readonly #runs = new Map<string, Run>();
  /** Individual source runs holding an Agent; one run's cleanup cannot release another's hold. */
  readonly #held = new Map<string, Set<symbol>>();

  constructor(private readonly options: AgentMigrationRunnerOptions) {}

  /** Whether a migration is moving this Agent's workspace off this Computer. */
  holds(agentId: string): boolean {
    return this.#held.has(agentId);
  }

  /**
   * Starts this lease's run, or joins the one already going for the same attempt and role; a run
   * still winding down after a cancel or stop is let finish first. Resolves when the run ends,
   * whatever its outcome.
   */
  lease(lease: AgentMigrationLeaseGrant): Promise<void> {
    const key = runKey(lease.migrationId, lease.generation, lease.role);
    const current = this.#runs.get(key);
    if (current && !current.stop.signal.aborted) return current.done;
    const stop = new AbortController();
    const owner = Symbol(key);
    if (lease.role === "source") {
      const held = this.#held.get(lease.agentId) ?? new Set<symbol>();
      held.add(owner);
      this.#held.set(lease.agentId, held);
    }
    const run: Run = {
      owner,
      stop,
      done: (current?.done ?? Promise.resolve())
        .then(() => this.#run(owner, lease, stop.signal))
        .finally(() => {
          if (this.#runs.get(key) === run) this.#runs.delete(key);
        }),
    };
    this.#runs.set(key, run);
    return run.done;
  }

  /** Ends the attempt's run here; the target drops its chunks, the source lets the Agent go. */
  async cancel(cancel: AgentMigrationCancel): Promise<void> {
    const key = runKey(cancel.migrationId, cancel.generation, cancel.role);
    const current = this.#runs.get(key);
    // Release this run synchronously so the server's following Start can proceed.
    if (current) this.#release(cancel.agentId, current.owner);
    current?.stop.abort();
    // Keep cleanup in the tracked run: a replacement lease must wait until it is finished.
    const stop = new AbortController();
    stop.abort();
    const barrier: Run = {
      owner: Symbol(key),
      stop,
      done: (current?.done ?? Promise.resolve())
        .finally(async () => {
          if (current) this.#release(cancel.agentId, current.owner);
          if (cancel.role === "target")
            await this.#dropAttempt(cancel.migrationId, cancel.generation);
        })
        .finally(() => {
          if (this.#runs.get(key) === barrier) this.#runs.delete(key);
        }),
    };
    this.#runs.set(key, barrier);
    await barrier.done;
    logger.info("agent_migration:canceled", {
      migration_id: cancel.migrationId,
      role: cancel.role,
      switched: cancel.switched,
    });
  }

  /** Ends every run, for a daemon shutting down; each attempt is leased again on the next ready. */
  async close(): Promise<void> {
    const runs = [...this.#runs.values()];
    for (const run of runs) run.stop.abort();
    await Promise.all(runs.map((run) => run.done));
  }

  #release(agentId: string, owner: symbol) {
    const held = this.#held.get(agentId);
    held?.delete(owner);
    if (held?.size === 0) this.#held.delete(agentId);
  }

  async #run(owner: symbol, lease: AgentMigrationLeaseGrant, signal: AbortSignal) {
    const fields = { migration_id: lease.migrationId, role: lease.role, agent_id: lease.agentId };
    const transfer: AgentMigrationTransfer = {
      migrationId: lease.migrationId,
      generation: lease.generation,
      deadline: lease.deadline,
      signal,
    };
    try {
      if (lease.role === "source") await this.#source(lease, transfer);
      else await this.#target(lease, transfer);
      logger.info("agent_migration:run_finished", fields);
    } catch (error) {
      if (signal.aborted) return;
      // Before the report: the server answers it by starting the Agent here again.
      if (lease.role === "source") this.#release(lease.agentId, owner);
      const errorCode = failureCode(error);
      logger.warn("agent_migration:run_failed", {
        ...fields,
        error_code: errorCode,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.options
        .server()
        .fail({ migrationId: lease.migrationId, generation: lease.generation, errorCode })
        .catch((reportError: unknown) =>
          logger.warn("agent_migration:fail_report_failed", {
            ...fields,
            error_code:
              reportError instanceof AgentMigrationRemoteError ? reportError.code : "unexpected",
          }),
        );
    } finally {
      if (lease.role === "source") this.#release(lease.agentId, owner);
    }
  }

  #view(transfer: AgentMigrationTransfer) {
    return retryUntilDeadline(transfer, "view", (signal) =>
      this.options.server().view(transfer.migrationId, signal),
    );
  }

  async #step(
    transfer: AgentMigrationTransfer,
    expectedRevision: number,
    step: AgentMigrationStep,
  ) {
    const result = await retryUntilDeadline(transfer, step, (signal) =>
      this.options.server().step(
        {
          migrationId: transfer.migrationId,
          generation: transfer.generation,
          expectedRevision,
          step,
        },
        signal,
      ),
    );
    return result.migration.revision;
  }

  async #source(lease: AgentMigrationLeaseGrant, transfer: AgentMigrationTransfer) {
    const { bucket, agents } = this.options;
    const view = await this.#view(transfer);
    const { state } = view.migration;
    if (!UNDECIDED.has(state)) return;
    // Whatever the state, an Agent this Computer is still the source for stays stopped.
    await agents.stop(lease.agentId);
    if (state === "requested" || state === "source_stopped") {
      let revision = view.migration.revision;
      if (state === "requested") revision = await this.#step(transfer, revision, "source_stopped");
      const workspaceDirectory = this.options.workspaceDirectory(lease.agentId);
      await ensureAgentMigrationIgnoreFile(workspaceDirectory);
      const selection = await selectAgentMigrationWorkspace(workspaceDirectory);
      const server = this.options.server();
      const { manifest, drift } = await writeAgentMigrationBundle({
        workspaceDirectory,
        selection,
        onChunk: (chunk) => uploadAgentMigrationChunk({ server, bucket }, { ...transfer, chunk }),
      });
      logger.info("agent_migration:bundle_uploaded", {
        migration_id: lease.migrationId,
        chunk_count: manifest.chunks.length,
        size_bytes: manifest.sizeBytes,
        excluded_secret_count: selection.excluded.secret.length,
        resized_count: drift.resized.length,
        skipped_count: drift.skipped.length,
      });
      await retryUntilDeadline(transfer, "upload_complete", (signal) =>
        this.options.server().completeUpload(
          {
            migrationId: lease.migrationId,
            generation: lease.generation,
            expectedRevision: revision,
            manifest,
          },
          signal,
        ),
      );
    }
    await this.#untilDecided(transfer);
  }

  /** Waits for the target's switch, or the migration's end, before letting the Agent go. */
  async #untilDecided(transfer: AgentMigrationTransfer) {
    const interval = this.options.outcomePollMs ?? OUTCOME_POLL_MS;
    while (UNDECIDED.has((await this.#view(transfer)).migration.state)) {
      if (Date.now() + interval >= transfer.deadline)
        throw new AgentMigrationTransferError("lease_expired", "waiting for the switch");
      await Bun.sleep(interval);
      if (transfer.signal?.aborted) throw new AgentMigrationTransferError("aborted", "waiting");
    }
  }

  async #target(lease: AgentMigrationLeaseGrant, transfer: AgentMigrationTransfer) {
    const { bucket, agents } = this.options;
    const view = await this.#view(transfer);
    const manifest = view.manifest;
    let revision = view.migration.revision;
    if (view.migration.state === "uploaded")
      revision = await this.#step(transfer, revision, "placement_started");
    else if (view.migration.state !== "placing") return;
    if (!manifest)
      throw new AgentMigrationTransferError("manifest_missing", "no manifest to place");
    const migrationDirectory = join(
      this.options.stateDirectory,
      "migrations",
      lease.migrationId,
      String(lease.generation),
    );
    const placement = {
      workspaceDirectory: this.options.workspaceDirectory(lease.agentId),
      backupDirectory: join(
        this.options.stateDirectory,
        "migration-workspace-backups",
        lease.agentId,
      ),
      agentId: lease.agentId,
      migrationId: lease.migrationId,
      generation: lease.generation,
    };
    let placed = false;
    try {
      await downloadAgentMigrationChunks(
        { server: this.options.server(), bucket },
        { ...transfer, chunks: manifest.chunks, migrationDirectory },
      );
      await commitAgentMigrationBundle({
        ...placement,
        migrationDirectory,
        manifest,
        agentRunning: agents.isRunning(lease.agentId),
      });
      placed = true;
      await this.#switch(transfer, revision);
    } catch (error) {
      // An unavailable outcome is not proof that the switch failed. Keep the placed copy and
      // its backup until ownership can be confirmed, including a cancel after the switch.
      const unknown =
        error instanceof AgentMigrationTransferError && error.code === "switch_unknown";
      if (placed && !unknown) await rollBackAgentMigrationPlacement(placement);
      throw error;
    } finally {
      await this.#dropAttempt(lease.migrationId, lease.generation);
    }
  }

  /** Reports the switch; a reply that never arrives is settled by reading what the server holds. */
  async #switch(transfer: AgentMigrationTransfer, revision: number) {
    try {
      await this.#step(transfer, revision, "switch");
    } catch (error) {
      const now = await this.#view(transfer).catch(() => null);
      const migration = now?.migration;
      if (migration?.generation === transfer.generation) {
        if (migration.state === "switched" || migration.state === "completed") return;
        if (UNDECIDED.has(migration.state) || migration.state === "failed") throw error;
      }
      // `canceled` alone does not say whether ownership had already switched.
      throw new AgentMigrationTransferError("switch_unknown", "ownership could not be confirmed");
    }
  }

  async #dropAttempt(migrationId: string, generation: number) {
    await rm(join(this.options.stateDirectory, "migrations", migrationId, String(generation)), {
      recursive: true,
      force: true,
    });
  }
}
