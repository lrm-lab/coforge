import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { escapePathIdentity, isSafePathScope } from "./path-scope";

const logger = getLogger(["coforge", "daemon", "runtime-backoff"]);

/** Why an Agent's deliveries are held across a restart: the class the runtime-error backoff
 * recorded, in the delivery queue's own vocabulary. */
export type PersistedBackoffReason = "rate_limit_backoff" | "runtime_error_backoff";

/** One Agent's backoff as it outlives the process: when it ends, and why it was taken. */
export type PersistedRuntimeBackoff = Readonly<{
  agentId: string;
  untilMs: number;
  reason: PersistedBackoffReason;
}>;

/** This OS process's lifetime, so a record written here is not restored by the same process: an
 * in-memory hold is the live authority for it, and a record only has to survive a *new* process. */
const PROCESS_OWNER = `${process.pid}:${Date.now()}`;

/** The file one Agent's backoff lives in, beside its other state. */
function backoffPath(stateDirectory: string | undefined, agentId: string): string {
  if (!stateDirectory) throw new Error("Agent state directory is required");
  if (!isSafePathScope(agentId)) throw new Error("invalid Agent state scope");
  return join(stateDirectory, "agent-state", escapePathIdentity(agentId), "runtime-backoff.json");
}

/**
 * The per-Agent runtime-error backoff, kept where a Daemon restart can find it again: the
 * reference Computer stores it in `lifecycleRecords` (`getProviderLimitBackoff`) and restores it
 * with `restoreProviderLimitBackoff`, so a usage limit that outlives the process keeps holding
 * deliveries instead of being retried into the same limit. Writes are one small private JSON
 * file per Agent; a corrupt or unreadable file is dropped rather than trusted.
 */
export class AgentRuntimeBackoffStore {
  /** A thunk: the runtime's state directory is assigned after its field initializers run. The
   * owner defaults to this process and is injectable for tests that stand in for a restart. */
  constructor(
    private readonly stateDirectory: () => string,
    private readonly owner: string = PROCESS_OWNER,
  ) {}

  /** Every stored backoff, for a starting Daemon to restore. A file that cannot be read is
   * removed: a stale record must not hold deliveries forever. */
  list(): PersistedRuntimeBackoff[] {
    const stateDirectory = this.stateDirectory();
    if (!stateDirectory) return [];
    const directory = join(stateDirectory, "agent-state");
    if (!existsSync(directory)) return [];
    const records: PersistedRuntimeBackoff[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Directory names are `escapePathIdentity` output; the only ids that matter decode cleanly.
      let agentId: string;
      try {
        agentId = decodeURIComponent(entry.name);
      } catch {
        continue;
      }
      if (!isSafePathScope(agentId)) continue;
      const path = backoffPath(stateDirectory, agentId);
      try {
        const value = JSON.parse(readFileSync(path, "utf8")) as {
          owner?: unknown;
          untilMs?: unknown;
          reason?: unknown;
        };
        // Written by this very process: its in-memory hold is the authority, not the file.
        if (value?.owner === this.owner) continue;
        const untilMs = value?.untilMs;
        const reason = value?.reason;
        if (
          typeof untilMs === "number" &&
          Number.isFinite(untilMs) &&
          (reason === "rate_limit_backoff" || reason === "runtime_error_backoff")
        ) {
          // A wait that ended while the Daemon was down is dropped, not restored.
          if (untilMs > Date.now()) records.push({ agentId, untilMs, reason });
          else this.clear(agentId);
        } else void this.clear(agentId);
      } catch {
        if (existsSync(path)) void this.clear(agentId);
      }
    }
    return records;
  }

  /** Written synchronously: one small private file on an error path, replaced atomically, with
   * no pending write outliving the report that made it. */
  save(agentId: string, state: Omit<PersistedRuntimeBackoff, "agentId">): void {
    try {
      const path = backoffPath(this.stateDirectory(), agentId);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
      const temporary = `${path}.tmp`;
      writeFileSync(
        temporary,
        `${JSON.stringify({ version: 1, owner: this.owner, untilMs: state.untilMs, reason: state.reason })}\n`,
        { mode: 0o600 },
      );
      renameSync(temporary, path);
    } catch (error) {
      // The hold decides delivery; a disk failure must not become a delivery failure.
      logger.warn("Runtime backoff could not be recorded", {
        event: "agent.runtime.backoff_persist_failed",
        agent_id: agentId,
        error_type: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  clear(agentId: string): void {
    const stateDirectory = this.stateDirectory();
    if (!stateDirectory) return;
    try {
      unlinkSync(backoffPath(stateDirectory, agentId));
    } catch {
      // Already gone, or never written: nothing to clear.
    }
  }
}
