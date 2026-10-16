import { getLogger } from "@logtape/logtape";
import { lstat, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAppItem, MintAppItem } from "#src/agent-app-inbox/agent-app-inbox";
import {
  SYSTEM_CLEANER_APP_ID,
  SYSTEM_CLEANER_CLASSES,
  systemCleanerItemId,
} from "#src/agent-app-inbox/registry";
import { AGENT_MIGRATION_IGNORE_FILE } from "#src/agent-migration/selection-rules";
import { defaultClock, type ReminderClock } from "#src/agent-reminder/reminder-scheduler";
import { AGENT_MEMORY_FILE } from "#src/agent-runtime/agent-workspace-path";
import { isSafePathScope } from "#src/persistence/path-scope";

const logger = getLogger(["coforge", "daemon", "system-cleaner"]);

/** The config bounds an owner's System Cleaner config must respect. */
export const SYSTEM_CLEANER_CONFIG_BOUNDS = {
  thresholdBytes: { min: 4096, max: 1024 ** 3 },
  intervalMs: { min: 900_000, max: 604_800_000 },
} as const;

/** What the cloud sends when an owner has not changed anything. */
export const SYSTEM_CLEANER_CONFIG_DEFAULTS = {
  enabled: true,
  thresholdBytes: 65_536,
  intervalMs: 3_600_000,
} as const;

const { memory: MEMORY_HINT, disk: DISK_HINT } = SYSTEM_CLEANER_CLASSES;
const CONFIG_KEYS = new Set([
  "appId",
  "ownerAgentId",
  "enabled",
  "thresholdBytes",
  "intervalMs",
  "revision",
]);
const DEFAULT_MEASUREMENT_TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MEMORY_GROWTH_FACTOR = 1.25;
const DISK_LOW_MAX_AVAILABLE_BYTES = 20 * 1024 ** 3;
const DISK_LOW_MAX_AVAILABLE_PERCENT = 10;
const CONFIG_COMMAND = `coforge app config --app ${SYSTEM_CLEANER_APP_ID}`;
const MEMORY_GUIDANCE =
  "Trim it back to an index: details belong in notes/, and stale entries can go.";
const CLEANUP_TIP_TITLE =
  "When it's quiet, remove workspace files you know are unused; check with your owner or creator on anything uncertain";
const CLEANUP_TIP_SUMMARY = `Only raise files added since your last question, and update ${AGENT_MIGRATION_IGNORE_FILE} as the workspace changes. Guide: coforge manual get workspace-cleanup`;

export type CleanerConfig = Readonly<{
  appId: typeof SYSTEM_CLEANER_APP_ID;
  ownerAgentId: string;
  enabled: boolean;
  thresholdBytes: number;
  intervalMs: number;
  revision: number;
}>;

export type CleanerConfigResult =
  | Readonly<{ kind: "applied"; activeSchedules: 0 | 1 }>
  | Readonly<{ kind: "stale"; currentRevision: number }>
  | Readonly<{ kind: "removed"; activeSchedules: 0 }>
  | Readonly<{ kind: "invalid"; reason: string }>;

export type MemoryMeasurement =
  | Readonly<{ kind: "measured"; bytes: number }>
  | Readonly<{ kind: "not_established"; reason: string }>;

export type DiskMeasurement =
  | Readonly<{ kind: "measured"; availableBytes: number; totalBytes: number }>
  | Readonly<{ kind: "not_established"; reason: string }>;

export type CleanerClock = ReminderClock;

/** The owner Agent's App Inbox, as far as the cleaner uses it. */
export type CleanerInbox = Readonly<{
  upsert(ownerAgentId: string, item: MintAppItem): Promise<AgentAppItem>;
  remove(ownerAgentId: string, itemId: string): Promise<boolean>;
}>;

export type SystemCleanerOptions = Readonly<{
  /** The directory holding every Agent workspace: `<agentsDirectory>/<agentId>/MEMORY.md`. */
  agentsDirectory: string;
  inbox: CleanerInbox;
  /** Tells a running, idle owner about `itemId`; never starts a stopped one. */
  wake(ownerAgentId: string, itemId: string): Promise<void>;
  clock?: CleanerClock;
  measurementTimeoutMs?: number;
  measureMemoryFile?(path: string): Promise<MemoryMeasurement>;
  measureDiskSpace?(path: string): Promise<DiskMeasurement>;
}>;

/** One owner's applied config; a new config replaces the whole object, so identity fences out a
 * period or measurement started under an older one. */
type OwnerState = { readonly config: CleanerConfig; timer: unknown };
type MemoryWakeReason = "first" | "cooldown_elapsed" | "grew";
type DueHints = { memory?: MemoryWakeReason; disk?: { availableBytes: number } };

/**
 * The System Cleaner: per owner Agent, every configured interval it measures the Agent's MEMORY.md
 * and the disk holding the Agent workspaces, and marks a hint due. A due hint is presented only
 * when the owner goes from Working to Idle, as a transient App Inbox item, and wakes only a
 * running idle owner. An owner with no config has no cleaner. All state is process-local.
 */
export class SystemCleaner {
  readonly #states = new Map<string, OwnerState>();
  readonly #due = new Map<string, DueHints>();
  readonly #memoryHintPresented = new Map<string, { atMs: number; bytes: number }>();
  readonly #cleanupTipAtMs = new Map<string, number>();
  readonly #diskTipAtMs = new Map<string, number>();
  readonly #diskLowTipped = new Set<string>();
  readonly #pending = new Set<Promise<void>>();
  readonly #clock: CleanerClock;
  readonly #measurementTimeoutMs: number;
  readonly #measureMemoryFile: (path: string) => Promise<MemoryMeasurement>;
  readonly #measureDiskSpace: (path: string) => Promise<DiskMeasurement>;

  constructor(private readonly options: SystemCleanerOptions) {
    this.#clock = options.clock ?? defaultClock;
    this.#measurementTimeoutMs = options.measurementTimeoutMs ?? DEFAULT_MEASUREMENT_TIMEOUT_MS;
    this.#measureMemoryFile = options.measureMemoryFile ?? measureMemoryFile;
    this.#measureDiskSpace = options.measureDiskSpace ?? measureDiskSpace;
  }

  applyConfig(raw: unknown): CleanerConfigResult {
    const parsed = parseCleanerConfig(raw);
    if (typeof parsed === "string") {
      logger.info("System Cleaner config rejected", {
        event: "system_cleaner:config_rejected",
        reason: parsed,
      });
      return { kind: "invalid", reason: parsed };
    }
    return this.#apply(parsed);
  }

  /** The cloud's authoritative config for exactly one owner; `null` means it has none. */
  replaceOwnerSnapshot(ownerAgentId: string, raw: unknown | null): CleanerConfigResult {
    if (!isSafePathScope(ownerAgentId))
      return { kind: "invalid", reason: "owner_agent_id_invalid" };
    if (raw === null) {
      this.#removeOwner(ownerAgentId);
      return { kind: "removed", activeSchedules: 0 };
    }
    const parsed = parseCleanerConfig(raw);
    if (typeof parsed === "string") return { kind: "invalid", reason: parsed };
    if (parsed.ownerAgentId !== ownerAgentId)
      return { kind: "invalid", reason: "owner_agent_id_mismatch" };
    return this.#apply(parsed);
  }

  #apply(parsed: CleanerConfig): CleanerConfigResult {
    const existing = this.#states.get(parsed.ownerAgentId);
    if (existing && existing.config.revision > parsed.revision)
      return { kind: "stale", currentRevision: existing.config.revision };
    if (existing && existing.config.revision === parsed.revision) {
      if (sameConfig(existing.config, parsed))
        return { kind: "stale", currentRevision: existing.config.revision };
      logger.info("System Cleaner config rejected", {
        event: "system_cleaner:config_rejected",
        agent_id: parsed.ownerAgentId,
        revision: parsed.revision,
        reason: "revision_conflict",
      });
      return { kind: "invalid", reason: "revision_conflict" };
    }
    this.#cancelTimer(existing);
    this.#dropItems(parsed.ownerAgentId);
    const state: OwnerState = { config: parsed, timer: undefined };
    this.#states.set(parsed.ownerAgentId, state);
    if (parsed.enabled) this.#arm(state);
    logger.info("System Cleaner config applied", {
      event: "system_cleaner:config_applied",
      agent_id: parsed.ownerAgentId,
      revision: parsed.revision,
      enabled: parsed.enabled,
      threshold_bytes: parsed.thresholdBytes,
      interval_ms: parsed.intervalMs,
    });
    return { kind: "applied", activeSchedules: state.timer === undefined ? 0 : 1 };
  }

  /** The owner just finished a turn: present whatever its last period marked due. */
  onAgentWorkingToIdle(ownerAgentId: string): void {
    const due = this.#due.get(ownerAgentId);
    if (!due) return;
    this.#due.delete(ownerAgentId);
    const state = this.#states.get(ownerAgentId);
    if (!state?.config.enabled) return;
    this.#track(this.#presentDue(ownerAgentId, state, due), ownerAgentId);
  }

  /** Cancels every schedule and drops every item: this process stops being the cleaner. */
  clear(): void {
    for (const ownerAgentId of this.#states.keys()) this.#removeOwner(ownerAgentId);
  }

  /** Resolves once every measurement, presentation and drop already started has finished. */
  async settled(): Promise<void> {
    while (this.#pending.size) await Promise.all(this.#pending);
  }

  #removeOwner(ownerAgentId: string): void {
    this.#cancelTimer(this.#states.get(ownerAgentId));
    this.#dropItems(ownerAgentId);
    this.#states.delete(ownerAgentId);
    this.#cleanupTipAtMs.delete(ownerAgentId);
    this.#diskTipAtMs.delete(ownerAgentId);
    this.#diskLowTipped.delete(ownerAgentId);
    this.#due.delete(ownerAgentId);
  }

  #markDue(ownerAgentId: string, hints: DueHints): void {
    this.#due.set(ownerAgentId, { ...this.#due.get(ownerAgentId), ...hints });
  }

  #clearDue(ownerAgentId: string, kind: keyof DueHints): void {
    const due = this.#due.get(ownerAgentId);
    if (!due) return;
    delete due[kind];
    if (due.memory === undefined && due.disk === undefined) this.#due.delete(ownerAgentId);
  }

  #track(work: Promise<unknown>, ownerAgentId: string): void {
    const run = work.then(
      () => {},
      (error: unknown) => {
        logger.warn("System Cleaner work failed", {
          event: "system_cleaner:failed",
          agent_id: ownerAgentId,
          error_name: error instanceof Error ? error.name : typeof error,
        });
      },
    );
    this.#pending.add(run);
    void run.finally(() => this.#pending.delete(run));
  }

  #arm(state: OwnerState): void {
    state.timer = this.#clock.schedule(
      () => this.#track(this.#runPeriod(state), state.config.ownerAgentId),
      state.config.intervalMs,
    );
  }

  #cancelTimer(state: OwnerState | undefined): void {
    if (state?.timer === undefined) return;
    this.#clock.cancel(state.timer);
    state.timer = undefined;
  }

  /** Only an enabled config is ever armed, and a new config replaces its state. */
  async #runPeriod(state: OwnerState): Promise<void> {
    const { ownerAgentId } = state.config;
    if (this.#states.get(ownerAgentId) !== state) return;
    this.#arm(state);
    await Promise.all([
      this.#checkMemory(ownerAgentId, state),
      this.#checkDisk(ownerAgentId, state),
    ]);
  }

  #isCurrent(ownerAgentId: string, state: OwnerState): boolean {
    return this.#states.get(ownerAgentId) === state;
  }

  #measureMemory(ownerAgentId: string): Promise<MemoryMeasurement> {
    return this.#withTimeout(() =>
      this.#measureMemoryFile(join(this.options.agentsDirectory, ownerAgentId, AGENT_MEMORY_FILE)),
    );
  }

  async #checkMemory(ownerAgentId: string, state: OwnerState): Promise<void> {
    const measurement = await this.#measureMemory(ownerAgentId);
    if (!this.#isCurrent(ownerAgentId, state)) return;
    if (
      measurement.kind === "not_established" ||
      measurement.bytes <= state.config.thresholdBytes
    ) {
      this.#clearDue(ownerAgentId, "memory");
      this.#dropItems(ownerAgentId, MEMORY_HINT.notificationClass);
      return;
    }
    const reason = this.#memoryWakeReason(ownerAgentId, measurement.bytes);
    if (reason) this.#markDue(ownerAgentId, { memory: reason });
  }

  #memoryWakeReason(ownerAgentId: string, bytes: number): MemoryWakeReason | undefined {
    const last = this.#memoryHintPresented.get(ownerAgentId);
    if (!last) return "first";
    if (this.#clock.now() - last.atMs >= DAY_MS) return "cooldown_elapsed";
    if (bytes >= last.bytes * MEMORY_GROWTH_FACTOR) return "grew";
    return undefined;
  }

  async #checkDisk(ownerAgentId: string, state: OwnerState): Promise<void> {
    const measurement = await this.#withTimeout(() =>
      this.#measureDiskSpace(this.options.agentsDirectory),
    );
    if (this.#states.get(ownerAgentId) !== state || measurement.kind === "not_established") return;
    const { availableBytes, totalBytes } = measurement;
    if (
      !Number.isFinite(availableBytes) ||
      availableBytes < 0 ||
      !Number.isFinite(totalBytes) ||
      totalBytes <= 0 ||
      availableBytes > totalBytes
    )
      return;
    if (!isDiskLow(availableBytes, totalBytes)) {
      this.#diskLowTipped.delete(ownerAgentId);
      this.#clearDue(ownerAgentId, "disk");
      return;
    }
    const lastDiskTipAtMs = this.#diskTipAtMs.get(ownerAgentId);
    if (
      !this.#diskLowTipped.has(ownerAgentId) &&
      (lastDiskTipAtMs === undefined || this.#clock.now() - lastDiskTipAtMs >= WEEK_MS)
    ) {
      this.#diskLowTipped.add(ownerAgentId);
      this.#markDue(ownerAgentId, { disk: { availableBytes } });
    }
  }

  async #presentDue(ownerAgentId: string, state: OwnerState, due: DueHints): Promise<void> {
    const minted: AgentAppItem[] = [];
    const memoryItem =
      due.memory === undefined ? undefined : await this.#presentMemoryHint(ownerAgentId, state);
    if (!this.#isCurrent(ownerAgentId, state)) return;
    if (memoryItem) minted.push(memoryItem);
    const nowMs = this.#clock.now();
    const lastTipAtMs = this.#cleanupTipAtMs.get(ownerAgentId);
    const weeklyTipAllowed = lastTipAtMs === undefined || nowMs - lastTipAtMs >= WEEK_MS;
    if (due.disk !== undefined || (memoryItem && weeklyTipAllowed)) {
      const tip = await this.#mint(ownerAgentId, {
        appId: SYSTEM_CLEANER_APP_ID,
        notificationClass: DISK_HINT.notificationClass,
        sourceRef: {
          kind: DISK_HINT.sourceKind,
          id: ownerAgentId,
          revision: String(state.config.revision),
        },
        title: CLEANUP_TIP_TITLE,
        summary:
          due.disk === undefined
            ? CLEANUP_TIP_SUMMARY
            : `Only ${formatBytes(due.disk.availableBytes)} of disk space is left. ${CLEANUP_TIP_SUMMARY}`,
      });
      if (!this.#isCurrent(ownerAgentId, state)) return;
      if (tip) {
        minted.push(tip);
        this.#cleanupTipAtMs.set(ownerAgentId, nowMs);
        if (due.disk !== undefined) this.#diskTipAtMs.set(ownerAgentId, nowMs);
      }
    }
    const first = minted[0];
    if (!first) return;
    logger.info("System Cleaner hint presented", {
      event: "system_cleaner:presented",
      agent_id: ownerAgentId,
      item_ids: minted.map((item) => item.itemId),
      memory_wake_reason: due.memory,
      disk_low: due.disk !== undefined,
    });
    await this.options.wake(ownerAgentId, first.itemId);
  }

  /** Remeasures first: the Agent may have trimmed MEMORY.md during the turn. */
  async #presentMemoryHint(
    ownerAgentId: string,
    state: OwnerState,
  ): Promise<AgentAppItem | undefined> {
    const measurement = await this.#measureMemory(ownerAgentId);
    if (!this.#isCurrent(ownerAgentId, state)) return undefined;
    const { thresholdBytes, intervalMs, revision } = state.config;
    if (measurement.kind === "not_established" || measurement.bytes <= thresholdBytes) {
      this.#dropItems(ownerAgentId, MEMORY_HINT.notificationClass);
      return undefined;
    }
    const item = await this.#mint(ownerAgentId, {
      appId: SYSTEM_CLEANER_APP_ID,
      notificationClass: MEMORY_HINT.notificationClass,
      sourceRef: { kind: MEMORY_HINT.sourceKind, id: ownerAgentId, revision: String(revision) },
      title: `MEMORY.md has grown to ${formatBytes(measurement.bytes)} (limit ${formatBytes(thresholdBytes)}); next check in ${formatInterval(intervalMs)}`,
      summary: `${MEMORY_GUIDANCE} ${memoryAction(thresholdBytes)}`,
    });
    if (item)
      this.#memoryHintPresented.set(ownerAgentId, {
        atMs: this.#clock.now(),
        bytes: measurement.bytes,
      });
    return item;
  }

  async #mint(ownerAgentId: string, item: MintAppItem): Promise<AgentAppItem | undefined> {
    try {
      return await this.options.inbox.upsert(ownerAgentId, item);
    } catch (error) {
      logger.warn("System Cleaner item was not minted", {
        event: "system_cleaner:mint_rejected",
        agent_id: ownerAgentId,
        notification_class: item.notificationClass,
        error_name: error instanceof Error ? error.name : typeof error,
      });
      return undefined;
    }
  }

  /** Drops the owner's items of one class, or of both. */
  #dropItems(ownerAgentId: string, notificationClass?: string): void {
    if (notificationClass === undefined || notificationClass === MEMORY_HINT.notificationClass)
      this.#memoryHintPresented.delete(ownerAgentId);
    for (const kind of notificationClass === undefined
      ? [MEMORY_HINT.notificationClass, DISK_HINT.notificationClass]
      : [notificationClass])
      this.#track(
        this.options.inbox.remove(ownerAgentId, systemCleanerItemId(kind, ownerAgentId)),
        ownerAgentId,
      );
  }

  #withTimeout<T extends { kind: string }>(
    measure: () => Promise<T>,
  ): Promise<T | Readonly<{ kind: "not_established"; reason: string }>> {
    return new Promise((resolve) => {
      // A second call is a no-op: `resolve` keeps the first result, and the timer is gone.
      const finish = (result: T | Readonly<{ kind: "not_established"; reason: string }>) => {
        this.#clock.cancel(timer);
        resolve(result);
      };
      const timer = this.#clock.schedule(
        () => finish({ kind: "not_established", reason: "timeout" }),
        this.#measurementTimeoutMs,
      );
      Promise.resolve()
        .then(measure)
        .then(finish, () => finish({ kind: "not_established", reason: "read_failed" }));
    });
  }
}

function parseCleanerConfig(raw: unknown): CleanerConfig | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "envelope_not_object";
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).some((key) => !CONFIG_KEYS.has(key))) return "envelope_unknown_field";
  if (row.appId !== SYSTEM_CLEANER_APP_ID) return "app_id_mismatch";
  if (typeof row.ownerAgentId !== "string" || !isSafePathScope(row.ownerAgentId))
    return "owner_agent_id_invalid";
  if (typeof row.enabled !== "boolean") return "enabled_invalid";
  const { thresholdBytes, intervalMs } = SYSTEM_CLEANER_CONFIG_BOUNDS;
  if (!withinBounds(row.thresholdBytes, thresholdBytes)) return "threshold_bytes_invalid";
  if (!withinBounds(row.intervalMs, intervalMs)) return "interval_ms_invalid";
  if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 0)
    return "revision_invalid";
  return {
    appId: SYSTEM_CLEANER_APP_ID,
    ownerAgentId: row.ownerAgentId,
    enabled: row.enabled,
    thresholdBytes: row.thresholdBytes as number,
    intervalMs: row.intervalMs as number,
    revision: row.revision as number,
  };
}

function withinBounds(value: unknown, bounds: Readonly<{ min: number; max: number }>): boolean {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= bounds.min &&
    (value as number) <= bounds.max
  );
}

function sameConfig(left: CleanerConfig, right: CleanerConfig): boolean {
  return (
    left.enabled === right.enabled &&
    left.thresholdBytes === right.thresholdBytes &&
    left.intervalMs === right.intervalMs
  );
}

/** What the memory hint's action does to the threshold: doubles it, capped at the maximum. */
function memoryAction(thresholdBytes: number): string {
  const maximum = SYSTEM_CLEANER_CONFIG_BOUNDS.thresholdBytes.max;
  if (thresholdBytes >= maximum)
    return `The limit is at its maximum; view or lower it with ${CONFIG_COMMAND}`;
  const doubled = thresholdBytes * 2;
  const next = Math.min(doubled, maximum);
  const change =
    next === doubled
      ? "To allow more, double the limit"
      : "To allow more, raise the limit to its maximum";
  return `${change} (or pick a lower value) with ${CONFIG_COMMAND} --set threshold_bytes=${next}`;
}

function isDiskLow(availableBytes: number, totalBytes: number): boolean {
  return (
    availableBytes < DISK_LOW_MAX_AVAILABLE_BYTES &&
    (availableBytes / totalBytes) * 100 < DISK_LOW_MAX_AVAILABLE_PERCENT
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function formatInterval(intervalMs: number): string {
  if (intervalMs % WEEK_MS === 0) return `${intervalMs / WEEK_MS}w`;
  if (intervalMs % DAY_MS === 0) return `${intervalMs / DAY_MS}d`;
  if (intervalMs % 3_600_000 === 0) return `${intervalMs / 3_600_000}h`;
  if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}m`;
  return `${Math.ceil(intervalMs / 1000)}s`;
}

/** MEMORY.md's size, measurable only when it is a regular file (never a symlink). */
export async function measureMemoryFile(path: string): Promise<MemoryMeasurement> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return { kind: "not_established", reason: "not_regular_file" };
    return { kind: "measured", bytes: info.size };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return { kind: "not_established", reason: "missing" };
    if (code === "EACCES" || code === "EPERM")
      return { kind: "not_established", reason: "permission_denied" };
    return { kind: "not_established", reason: "read_failed" };
  }
}

/** Free and total space of the filesystem holding `path`. */
export async function measureDiskSpace(path: string): Promise<DiskMeasurement> {
  try {
    const info = await statfs(path);
    return {
      kind: "measured",
      availableBytes: info.bavail * info.bsize,
      totalBytes: info.blocks * info.bsize,
    };
  } catch {
    return { kind: "not_established", reason: "read_failed" };
  }
}
