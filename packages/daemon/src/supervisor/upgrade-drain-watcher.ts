import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import {
  isRunnerHoldReason,
  thrownMessage,
  type RunnerHoldReason,
} from "@lrm/coforge-sdk/internal";

export const UPGRADE_DRAIN_SCHEMA_VERSION = 1;
export const UPGRADE_DRAIN_REQUEST_FILE = "upgrade-drain-request.json";
export const UPGRADE_DRAIN_STATE_FILE = "upgrade-drain-state.json";
export const UPGRADE_DRAIN_POLL_MS = 250;
export const UPGRADE_DRAIN_STATE_HEARTBEAT_MS = 1_000;
export const UPGRADE_DRAIN_MAX_TTL_MS = 10 * 60_000;

const UPGRADE_DRAIN_MAX_REQUEST_BYTES = 16 * 1024;
const UPGRADE_DRAIN_MAX_ID_LENGTH = 256;

const logger = getLogger(["coforge", "daemon", "supervisor"]);

export type UpgradeDrainHoldResult = {
  busyCount: number;
};

export type UpgradeDrainWatcherOptions = {
  stateDirectory: string;
  hold: (
    reason: RunnerHoldReason,
    drainId: string,
    publishPending: () => Promise<void>,
  ) => Promise<UpgradeDrainHoldResult>;
  release: () => Promise<void>;
  pollMs?: number;
  heartbeatMs?: number;
  now?: () => number;
};

type UpgradeDrainRequest = {
  schemaVersion: number;
  drainId: string;
  reason: RunnerHoldReason;
  requestedAtMs: number;
  deadlineAtMs: number;
};

type UpgradeDrainState = {
  schemaVersion: number;
  drainId: string;
  held: boolean;
  busyCount: number;
  updatedAtMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUpgradeDrainRequest(raw: unknown, nowMs: number): UpgradeDrainRequest | null {
  if (!isRecord(raw)) return null;
  if (raw.schemaVersion !== UPGRADE_DRAIN_SCHEMA_VERSION) return null;
  if (
    typeof raw.drainId !== "string" ||
    raw.drainId.length === 0 ||
    raw.drainId.length > UPGRADE_DRAIN_MAX_ID_LENGTH
  )
    return null;
  if (!isRunnerHoldReason(raw.reason)) return null;
  if (typeof raw.requestedAtMs !== "number" || !Number.isFinite(raw.requestedAtMs)) return null;
  if (typeof raw.deadlineAtMs !== "number" || !Number.isFinite(raw.deadlineAtMs)) return null;
  const effectiveDeadline = Math.min(
    raw.deadlineAtMs,
    raw.requestedAtMs + UPGRADE_DRAIN_MAX_TTL_MS,
  );
  if (nowMs >= effectiveDeadline) return null;
  return {
    schemaVersion: UPGRADE_DRAIN_SCHEMA_VERSION,
    drainId: raw.drainId,
    reason: raw.reason,
    requestedAtMs: raw.requestedAtMs,
    deadlineAtMs: effectiveDeadline,
  };
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export class UpgradeDrainWatcher {
  readonly #requestPath: string;
  readonly #statePath: string;
  readonly #hold: UpgradeDrainWatcherOptions["hold"];
  readonly #release: () => Promise<void>;
  readonly #pollMs: number;
  readonly #heartbeatMs: number;
  readonly #now: () => number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling = false;
  #stopped = false;
  #activeDrainId: string | null = null;
  #lastWritten: UpgradeDrainState | null = null;
  #cleanedStaleState = false;

  constructor(options: UpgradeDrainWatcherOptions) {
    this.#requestPath = join(options.stateDirectory, UPGRADE_DRAIN_REQUEST_FILE);
    this.#statePath = join(options.stateDirectory, UPGRADE_DRAIN_STATE_FILE);
    this.#hold = options.hold;
    this.#release = options.release;
    this.#pollMs = options.pollMs ?? UPGRADE_DRAIN_POLL_MS;
    this.#heartbeatMs = options.heartbeatMs ?? UPGRADE_DRAIN_STATE_HEARTBEAT_MS;
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    if (this.#timer || this.#stopped) return;
    void this.pollOnce();
    this.#timer = setInterval(() => {
      void this.pollOnce();
    }, this.#pollMs);
    this.#timer.unref?.();
  }

  stop(): void {
    this.#stopped = true;
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async pollOnce(): Promise<void> {
    if (this.#polling || this.#stopped) return;
    this.#polling = true;
    try {
      const nowMs = this.#now();
      const request = await this.#readRequest(nowMs);
      if (this.#stopped) return;
      if (request) {
        this.#cleanedStaleState = true;
        await this.#engage(request, nowMs);
        return;
      }
      if (this.#activeDrainId !== null) {
        const previousDrainId = this.#activeDrainId;
        this.#activeDrainId = null;
        this.#lastWritten = null;
        await this.#removeStateFile();
        if (this.#stopped) return;
        await this.#releaseHold(previousDrainId);
        return;
      }
      if (!this.#cleanedStaleState) {
        this.#cleanedStaleState = true;
        await this.#removeStateFile();
      }
    } finally {
      this.#polling = false;
    }
  }

  async #readRequest(nowMs: number): Promise<UpgradeDrainRequest | null> {
    if (!(await Bun.file(this.#requestPath).exists())) return null;
    let stat;
    try {
      stat = await lstat(this.#requestPath);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return null;
      logger.warn("Failed to stat upgrade drain request file", {
        event: "upgrade:drain_request_stat_failed",
        error_message: thrownMessage(error),
      });
      return null;
    }
    if (!stat.isFile() || stat.size > UPGRADE_DRAIN_MAX_REQUEST_BYTES) return null;
    try {
      const raw = JSON.parse(await readFile(this.#requestPath, "utf8")) as unknown;
      return parseUpgradeDrainRequest(raw, nowMs);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return null;
      logger.warn("Ignored malformed upgrade drain request file", {
        event: "upgrade:drain_request_invalid",
        error_message: thrownMessage(error),
      });
      return null;
    }
  }

  async #engage(request: UpgradeDrainRequest, nowMs: number): Promise<void> {
    let result: UpgradeDrainHoldResult;
    try {
      result = await this.#hold(request.reason, request.drainId, async () => {
        if (this.#lastWritten?.drainId !== request.drainId) await this.#publish(request, 1, nowMs);
      });
    } catch (error) {
      logger.warn("Upgrade drain hold fan-out failed", {
        event: "upgrade:drain_hold_failed",
        drain_id: request.drainId,
        error_message: thrownMessage(error),
      });
      return;
    }
    await this.#publish(request, Math.max(0, Math.trunc(result.busyCount)), this.#now());
  }

  async #publish(request: UpgradeDrainRequest, busyCount: number, nowMs: number): Promise<void> {
    if (this.#stopped) return;
    const current = await this.#readRequest(nowMs);
    if (this.#stopped || current?.drainId !== request.drainId) return;
    const isNewDrain = this.#activeDrainId !== request.drainId;
    this.#activeDrainId = request.drainId;
    if (isNewDrain)
      logger.info("Upgrade drain hold engaged", {
        event: "upgrade:drain_engaged",
        drain_id: request.drainId,
        busy_count: busyCount,
      });
    const shouldWrite =
      !this.#lastWritten ||
      this.#lastWritten.drainId !== request.drainId ||
      this.#lastWritten.busyCount !== busyCount ||
      nowMs - this.#lastWritten.updatedAtMs >= this.#heartbeatMs;
    if (!shouldWrite) return;
    const nextState: UpgradeDrainState = {
      schemaVersion: UPGRADE_DRAIN_SCHEMA_VERSION,
      drainId: request.drainId,
      held: true,
      busyCount,
      updatedAtMs: nowMs,
    };
    if (await this.#writeStateFile(nextState)) this.#lastWritten = nextState;
  }

  async #releaseHold(drainId: string): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.#release();
      logger.info("Upgrade drain hold released", {
        event: "upgrade:drain_released",
        drain_id: drainId,
      });
    } catch (error) {
      logger.warn("Upgrade drain hold release failed", {
        event: "upgrade:drain_release_failed",
        drain_id: drainId,
        error_message: thrownMessage(error),
      });
    }
  }

  async #writeStateFile(state: UpgradeDrainState): Promise<boolean> {
    if (this.#stopped) return false;
    try {
      const existing = await lstat(this.#statePath);
      if (!existing.isFile()) return false;
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) return false;
    }
    const tempPath = `${this.#statePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      await writeFile(tempPath, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
      if (this.#stopped) {
        await rm(tempPath, { force: true }).catch(() => {});
        return false;
      }
      await rename(tempPath, this.#statePath);
      return true;
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      logger.warn("Failed to write upgrade drain state file", {
        event: "upgrade:drain_state_write_failed",
        drain_id: state.drainId,
        error_message: thrownMessage(error),
      });
      return false;
    }
  }

  async #removeStateFile(): Promise<void> {
    if (!(await Bun.file(this.#statePath).exists())) return;
    try {
      const existing = await lstat(this.#statePath);
      if (!existing.isFile()) return;
      await rm(this.#statePath, { force: true });
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return;
      logger.warn("Failed to remove upgrade drain state file", {
        event: "upgrade:drain_state_remove_failed",
        error_message: thrownMessage(error),
      });
    }
  }
}
