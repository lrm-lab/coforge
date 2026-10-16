import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import type { AgentMigrationCancel, AgentMigrationLease } from "@lrm/coforge-sdk/internal";
import {
  agentWorkspacePlacement,
  commitAgentMigrationBundle,
  rollBackAgentMigrationPlacement,
} from "./bundle-commit";
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
import {
  exists,
  moveWorkspaceToBackup,
  pruneWorkspaceBackups,
  sourceBackupName,
} from "./workspace-backups";

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
    /** The Agent has moved to another Computer and its workspace here was archived. */
    movedAway(agentId: string): void;
  };
  workspaceDirectory(agentId: string): string;
  /** The daemon's state directory; migration attempts and workspace backups live under it. */
  stateDirectory: string;
  /** How often a source holding its Agent asks whether the migration is decided. */
  outcomePollMs?: number;
};

type Run = {
  owner: symbol;
  agentId: string;
  role: "source" | "target";
  stop: AbortController;
  done: Promise<void>;
};

/** The route's grammar for a failure code. */
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const OUTCOME_POLL_MS = 5_000;
/** How long an attempt directory no run claims is kept before it is cleared. */
const LEFTOVER_ATTEMPT_MS = 7 * 24 * 60 * 60 * 1000;
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
  /** Placement and archiving share one workspace; unrelated Agents may still proceed together. */
  readonly #workspaceOperations = new Map<string, Promise<void>>();

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
      agentId: lease.agentId,
      role: lease.role,
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
      agentId: cancel.agentId,
      role: cancel.role,
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

  #withWorkspace(agentId: string, operation: () => Promise<void>): Promise<void> {
    const next = (this.#workspaceOperations.get(agentId) ?? Promise.resolve()).then(
      operation,
      operation,
    );
    const settled = next.catch(() => {});
    this.#workspaceOperations.set(agentId, settled);
    void settled.finally(() => {
      if (this.#workspaceOperations.get(agentId) === settled)
        this.#workspaceOperations.delete(agentId);
    });
    return next;
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
      if (lease.role === "source") await this.#source(lease, transfer, owner);
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
      });
      await this.options
        .server()
        .fail({ migrationId: lease.migrationId, generation: lease.generation, errorCode })
        .catch((reportError: unknown) =>
          logger.warn("agent_migration:fail_report_failed", {
            ...fields,
            error_code: failureCode(reportError),
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

  async #source(lease: AgentMigrationLeaseGrant, transfer: AgentMigrationTransfer, owner: symbol) {
    const { bucket, agents } = this.options;
    const view = await this.#view(transfer);
    const { state } = view.migration;
    // A run that did not upload the workspace cannot tell it from one placed here since, so it
    // leaves it where it is.
    if (!UNDECIDED.has(state)) return;
    // Whatever the state, an Agent this Computer is still the source for stays stopped.
    await agents.stop(lease.agentId);
    let uploaded: string | undefined;
    if (state === "requested" || state === "source_stopped") {
      let revision = view.migration.revision;
      if (state === "requested") revision = await this.#step(transfer, revision, "source_stopped");
      const workspaceDirectory = this.options.workspaceDirectory(lease.agentId);
      uploaded = await agentWorkspacePlacement(workspaceDirectory);
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
    const decided = await this.#untilDecided(transfer);
    // Let go first: archiving can take a while, and nothing here may run the Agent again anyway.
    this.#release(lease.agentId, owner);
    if (uploaded !== undefined) await this.#archiveSource(lease, decided, uploaded);
  }

  /**
   * Waits for the target's switch, or the migration's end, before letting the Agent go; resolves
   * with the state that decided it.
   */
  async #untilDecided(transfer: AgentMigrationTransfer) {
    const interval = this.options.outcomePollMs ?? OUTCOME_POLL_MS;
    for (;;) {
      const { state } = (await this.#view(transfer)).migration;
      if (!UNDECIDED.has(state)) return state;
      if (Date.now() + interval >= transfer.deadline)
        throw new AgentMigrationTransferError("lease_expired", "waiting for the switch");
      await Bun.sleep(interval);
      if (transfer.signal?.aborted) throw new AgentMigrationTransferError("aborted", "waiting");
    }
  }

  /**
   * The Agent has moved away: what it left in its workspace here becomes a backup, so the Agents'
   * tree holds only Agents that run here and the move can still be undone by hand for a while.
   * Only the very workspace this run uploaded is archived: a later migration may have placed the
   * Agent back here meanwhile, and a placement still in flight is never touched. The migration has
   * already succeeded, so a failure here is logged, never reported as the migration's.
   */
  async #archiveSource(
    lease: AgentMigrationLeaseGrant,
    state: AgentMigrationState,
    uploaded: string,
  ) {
    if (state !== "switched" && state !== "completed") return;
    await this.#withWorkspace(lease.agentId, async () => {
      const workspaceDirectory = this.options.workspaceDirectory(lease.agentId);
      const backupDirectory = this.#backupDirectory(lease.agentId);
      try {
        const placing = [...this.#runs.values()].some(
          (run) => run.agentId === lease.agentId && run.role === "target",
        );
        if (placing || !(await exists(workspaceDirectory))) return;
        if ((await agentWorkspacePlacement(workspaceDirectory)) !== uploaded) return;
        // Already archived by an earlier run of this same migration.
        if (await exists(join(backupDirectory, sourceBackupName(lease.migrationId)))) return;
        await moveWorkspaceToBackup(
          workspaceDirectory,
          backupDirectory,
          sourceBackupName(lease.migrationId),
        );
        await pruneWorkspaceBackups(backupDirectory);
        logger.info("agent_migration:source_archived", { migration_id: lease.migrationId });
        this.options.agents.movedAway(lease.agentId);
      } catch (error) {
        logger.warn("agent_migration:source_archive_failed", {
          migration_id: lease.migrationId,
          error_code: failureCode(error),
        });
      }
    });
  }

  #backupDirectory(agentId: string) {
    return join(this.options.stateDirectory, "migration-workspace-backups", agentId);
  }

  /**
   * Clears what runs that never finished left behind: attempt directories created more than a
   * week ago (an attempt's lease is an hour, so none is still in use), and every Agent's backups
   * past what is kept. Called as the daemon starts, before it takes any lease; an Agent with a run
   * in flight is passed over all the same.
   */
  async pruneLeftovers(now = Date.now()) {
    const attempts = join(this.options.stateDirectory, "migrations");
    for (const name of await readdir(attempts).catch(() => [] as string[])) {
      if ([...this.#runs.keys()].some((key) => key.startsWith(`${name}:`))) continue;
      const path = join(attempts, name);
      const touched = (await stat(path).catch(() => null))?.mtimeMs;
      if (touched !== undefined && now - touched > LEFTOVER_ATTEMPT_MS)
        await rm(path, { recursive: true, force: true });
    }
    const backups = join(this.options.stateDirectory, "migration-workspace-backups");
    for (const agentId of await readdir(backups).catch(() => [] as string[])) {
      if ([...this.#runs.values()].some((run) => run.agentId === agentId)) continue;
      await pruneWorkspaceBackups(join(backups, agentId), now).catch((error: unknown) =>
        logger.warn("agent_migration:backup_prune_failed", {
          agent_id: agentId,
          error_code: failureCode(error),
        }),
      );
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
      backupDirectory: this.#backupDirectory(lease.agentId),
      agentId: lease.agentId,
      migrationId: lease.migrationId,
      generation: lease.generation,
    };
    try {
      await downloadAgentMigrationChunks(
        { server: this.options.server(), bucket },
        { ...transfer, chunks: manifest.chunks, migrationDirectory },
      );
      await this.#withWorkspace(lease.agentId, async () => {
        if (transfer.signal?.aborted)
          throw new AgentMigrationTransferError("aborted", "placing the workspace");
        if (Date.now() >= transfer.deadline)
          throw new AgentMigrationTransferError("lease_expired", "placing the workspace");
        let placed = false;
        try {
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
        }
      });
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
