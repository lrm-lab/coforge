import { measureKnowledgeSize } from "#src/local-memory/knowledge-size";
import { getLogger } from "@logtape/logtape";
import { join } from "node:path";
import type { AgentAppItem, MintAppItem } from "#src/agent-app-inbox/agent-app-inbox";
import {
  SYSTEM_CLEANER_APP_ID,
  SYSTEM_CLEANER_CLASSES,
  systemCleanerItemId,
} from "#src/agent-app-inbox/registry";
import { defaultClock } from "#src/agent-reminder/reminder-clock";
import { isSafePathScope } from "#src/persistence/path-scope";
import {
  parseCleanerConfig,
  sameConfig,
  type CleanerClock,
  type CleanerConfig,
  type CleanerConfigResult,
  type SystemCleanerOptions,
} from "./system-cleaner-config";
import {
  evaluateDiskPeriod,
  measureDiskSpace,
  measureMemoryFile,
  withMeasurementTimeout,
  type MemoryMeasurement,
} from "./system-cleaner-measure";
import {
  buildFileHintDraft,
  FILE_HINTS,
  FILE_KINDS,
  fileThresholdForConfig,
  fileWakeReason,
  WEEK_MS,
  type FileKind,
  type MemoryWakeReason,
  type PeriodDiskRow,
  type PeriodFileRow,
  type PeriodWorkspaceRow,
  type PresentedMark,
} from "./system-cleaner-hints";
import {
  DEFAULT_HEAVY_WORKSPACE_THRESHOLD_BYTES,
  evaluateDiskTipAtIdle,
  evaluateWorkspacePeriod,
  scanWorkspaceHeavyPaths,
  type WorkspaceHeavyPathsMeasurement,
} from "./workspace-heavy-paths";

const logger = getLogger(["coforge", "daemon", "system-cleaner"]);

const { disk: DISK_HINT } = SYSTEM_CLEANER_CLASSES;
const DEFAULT_MEASUREMENT_TIMEOUT_MS = 10_000;

export type {
  CleanerClock,
  CleanerConfigResult,
  CleanerInbox,
  SystemCleanerOptions,
} from "./system-cleaner-config";
export type { DiskMeasurement, MemoryMeasurement } from "./system-cleaner-measure";
export type { WorkspaceHeavyPathsMeasurement } from "./workspace-heavy-paths";

type OwnerState = { readonly config: CleanerConfig; timer: unknown };
type DueHints = {
  memory?: MemoryWakeReason;
  activeContext?: MemoryWakeReason;
  knowledge?: MemoryWakeReason;
  disk?: { availableBytes: number };
  workspace?: MemoryWakeReason;
};

export class SystemCleaner {
  readonly #states = new Map<string, OwnerState>();
  readonly #due = new Map<string, DueHints>();
  readonly #memoryChanged = new Set<string>();
  readonly #idleChecks = new Set<string>();
  readonly #idleAgain = new Set<string>();
  readonly #fileHintPresented: Record<FileKind, Map<string, PresentedMark>> = {
    memory: new Map(),
    activeContext: new Map(),
    knowledge: new Map(),
  };
  readonly #cleanupTipAtMs = new Map<string, number>();
  readonly #diskTipAtMs = new Map<string, number>();
  readonly #diskLowTipped = new Set<string>();
  readonly #workspaceTip = new Map<string, PresentedMark>();
  readonly #pending = new Set<Promise<void>>();
  readonly #clock: CleanerClock;
  readonly #measurementTimeoutMs: number;
  readonly #workspaceThresholdBytes: number;

  constructor(private readonly options: SystemCleanerOptions) {
    this.#clock = options.clock ?? defaultClock;
    this.#measurementTimeoutMs = options.measurementTimeoutMs ?? DEFAULT_MEASUREMENT_TIMEOUT_MS;
    this.#workspaceThresholdBytes =
      options.workspaceHeavyThresholdBytes ?? DEFAULT_HEAVY_WORKSPACE_THRESHOLD_BYTES;
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
    if (!parsed.enabled) {
      this.#memoryChanged.delete(parsed.ownerAgentId);
      this.#idleAgain.delete(parsed.ownerAgentId);
    } else if (this.#idleChecks.has(parsed.ownerAgentId)) {
      this.#memoryChanged.add(parsed.ownerAgentId);
      this.#idleAgain.add(parsed.ownerAgentId);
    }
    const state: OwnerState = { config: parsed, timer: undefined };
    this.#states.set(parsed.ownerAgentId, state);
    if (parsed.enabled) this.#arm(state);
    logger.info("System Cleaner config applied", {
      event: "system_cleaner:config_applied",
      agent_id: parsed.ownerAgentId,
      revision: parsed.revision,
      enabled: parsed.enabled,
      threshold_bytes: parsed.thresholdBytes,
      active_context_threshold_bytes: parsed.activeContextThresholdBytes,
      interval_ms: parsed.intervalMs,
    });
    return { kind: "applied", activeSchedules: state.timer === undefined ? 0 : 1 };
  }

  onMemoryWrite(ownerAgentId: string): void {
    if (this.#states.get(ownerAgentId)?.config.enabled) this.#memoryChanged.add(ownerAgentId);
  }

  onAgentWorkingToIdle(ownerAgentId: string): void {
    const state = this.#states.get(ownerAgentId);
    if (!state?.config.enabled) return;
    if (this.#idleChecks.has(ownerAgentId)) {
      this.#idleAgain.add(ownerAgentId);
      return;
    }
    if (!this.#memoryChanged.has(ownerAgentId) && !this.#due.has(ownerAgentId)) return;
    this.#idleChecks.add(ownerAgentId);
    this.#track(
      this.#checkAtIdle(ownerAgentId, state).finally(() => {
        this.#idleChecks.delete(ownerAgentId);
        if (this.#idleAgain.delete(ownerAgentId)) this.onAgentWorkingToIdle(ownerAgentId);
      }),
      ownerAgentId,
    );
  }

  async #checkAtIdle(ownerAgentId: string, state: OwnerState): Promise<void> {
    if (this.#memoryChanged.delete(ownerAgentId))
      await Promise.all(FILE_KINDS.map((kind) => this.#checkFile(ownerAgentId, state, kind)));
    if (!this.#isCurrent(state)) return;
    const due = this.#due.get(ownerAgentId);
    this.#due.delete(ownerAgentId);
    if (due) await this.#presentDue(ownerAgentId, state, due);
  }

  clear(): void {
    for (const ownerAgentId of this.#states.keys()) this.#removeOwner(ownerAgentId);
  }

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
    this.#workspaceTip.delete(ownerAgentId);
    this.#due.delete(ownerAgentId);
    this.#memoryChanged.delete(ownerAgentId);
    this.#idleAgain.delete(ownerAgentId);
  }

  #markDue(ownerAgentId: string, hints: DueHints): void {
    this.#due.set(ownerAgentId, { ...this.#due.get(ownerAgentId), ...hints });
  }

  #clearDue(ownerAgentId: string, kind: keyof DueHints): void {
    const due = this.#due.get(ownerAgentId);
    if (!due) return;
    delete due[kind];
    if (Object.values(due).every((value) => value === undefined)) this.#due.delete(ownerAgentId);
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

  async #runPeriod(state: OwnerState): Promise<void> {
    const { ownerAgentId } = state.config;
    if (!this.#isCurrent(state)) return;
    this.#arm(state);
    const [files, disk, workspace] = await Promise.all([
      Promise.all(FILE_KINDS.map((kind) => this.#checkFile(ownerAgentId, state, kind))),
      this.#checkDisk(ownerAgentId, state),
      this.#checkWorkspace(ownerAgentId, state),
    ]);
    if (!this.#isCurrent(state)) return;
    logger.info("System Cleaner period measured", {
      event: "system_cleaner:period",
      agent_id: ownerAgentId,
      revision: state.config.revision,
      files: files.filter((row): row is PeriodFileRow => row !== undefined),
      disk: disk ?? { not_established: "stale" },
      workspace: workspace ?? {
        threshold_bytes: this.#workspaceThresholdBytes,
        not_established: "stale",
      },
    });
  }

  #isCurrent(state: OwnerState): boolean {
    return this.#states.get(state.config.ownerAgentId) === state;
  }

  #filePath(ownerAgentId: string, kind: FileKind): string {
    return join(this.options.agentsDirectory, ownerAgentId, FILE_HINTS[kind].path);
  }

  #measureFile(ownerAgentId: string, relativePath: string): Promise<MemoryMeasurement> {
    return withMeasurementTimeout(this.#clock, this.#measurementTimeoutMs, () =>
      relativePath === "notes/knowledge"
        ? (this.options.measureKnowledgeSize ?? measureKnowledgeSize)(
            join(this.options.agentsDirectory, ownerAgentId),
          )
        : (this.options.measureMemoryFile ?? measureMemoryFile)(
            join(this.options.agentsDirectory, ownerAgentId, relativePath),
          ),
    );
  }

  #measureWorkspace(ownerAgentId: string): Promise<WorkspaceHeavyPathsMeasurement> {
    const dir = join(this.options.agentsDirectory, ownerAgentId);
    return withMeasurementTimeout(this.#clock, this.#measurementTimeoutMs, () =>
      this.options.scanWorkspaceHeavyPaths
        ? this.options.scanWorkspaceHeavyPaths(dir)
        : scanWorkspaceHeavyPaths(dir, { nowMs: () => this.#clock.now() }),
    );
  }

  async #checkFile(
    ownerAgentId: string,
    state: OwnerState,
    kind: FileKind,
  ): Promise<PeriodFileRow | undefined> {
    const hint = FILE_HINTS[kind];
    const thresholdBytes = fileThresholdForConfig(state.config, kind);
    const measurement = await this.#measureFile(ownerAgentId, hint.path);
    const row: PeriodFileRow = {
      ...(measurement.kind === "measured" && measurement.incomplete ? { incomplete: true } : {}),
      file: this.#filePath(ownerAgentId, kind),
      threshold_bytes: thresholdBytes,
    };
    if (!this.#isCurrent(state)) return undefined;
    if (measurement.kind === "not_established" || measurement.bytes <= thresholdBytes) {
      this.#clearDue(ownerAgentId, kind);
      this.#dropItems(ownerAgentId, hint.notificationClass);
      return measurement.kind === "not_established"
        ? { ...row, not_established: measurement.reason }
        : { ...row, bytes: measurement.bytes };
    }
    const reason = fileWakeReason(
      this.#fileHintPresented[kind].get(ownerAgentId),
      this.#clock.now(),
      measurement.bytes,
    );
    if (reason) this.#markDue(ownerAgentId, { [kind]: reason });
    return { ...row, bytes: measurement.bytes, due: reason };
  }

  async #checkDisk(ownerAgentId: string, state: OwnerState): Promise<PeriodDiskRow | undefined> {
    const measurement = await withMeasurementTimeout(this.#clock, this.#measurementTimeoutMs, () =>
      (this.options.measureDiskSpace ?? measureDiskSpace)(this.options.agentsDirectory),
    );
    if (!this.#isCurrent(state)) return undefined;
    const outcome = evaluateDiskPeriod(
      measurement,
      this.#diskLowTipped.has(ownerAgentId),
      this.#diskTipAtMs.get(ownerAgentId),
      this.#clock.now(),
      WEEK_MS,
    );
    if (outcome.recovered) {
      this.#diskLowTipped.delete(ownerAgentId);
      this.#clearDue(ownerAgentId, "disk");
    } else if (outcome.availableBytes !== undefined) {
      this.#diskLowTipped.add(ownerAgentId);
      this.#markDue(ownerAgentId, { disk: { availableBytes: outcome.availableBytes } });
    }
    return outcome.row;
  }

  async #checkWorkspace(
    ownerAgentId: string,
    state: OwnerState,
  ): Promise<PeriodWorkspaceRow | undefined> {
    const measurement = await this.#measureWorkspace(ownerAgentId);
    if (!this.#isCurrent(state)) return undefined;
    const outcome = evaluateWorkspacePeriod(
      measurement,
      this.#workspaceThresholdBytes,
      this.#workspaceTip.get(ownerAgentId),
      this.#clock.now(),
    );
    if (outcome.clearDue) this.#clearDue(ownerAgentId, "workspace");
    else if (outcome.due) this.#markDue(ownerAgentId, { workspace: outcome.due });
    return outcome.row;
  }

  async #presentDue(ownerAgentId: string, state: OwnerState, due: DueHints): Promise<void> {
    const minted: AgentAppItem[] = [];
    const presentedFiles: { file: string; bytes: number; thresholdBytes: number }[] = [];
    for (const kind of FILE_KINDS) {
      if (due[kind] === undefined) continue;
      const result = await this.#presentFileHint(ownerAgentId, state, kind);
      if (!this.#isCurrent(state)) return;
      if (result) {
        minted.push(result.item);
        presentedFiles.push({
          file: this.#filePath(ownerAgentId, kind),
          bytes: result.bytes,
          thresholdBytes: result.thresholdBytes,
        });
      }
    }
    const lastTipAtMs = this.#cleanupTipAtMs.get(ownerAgentId);
    const weeklyTipAllowed =
      lastTipAtMs === undefined || this.#clock.now() - lastTipAtMs >= WEEK_MS;
    let workspaceHeavy = false;
    if (
      due.disk !== undefined ||
      due.workspace !== undefined ||
      (minted.length > 0 && weeklyTipAllowed)
    ) {
      const scanned = await this.#measureWorkspace(ownerAgentId);
      if (!this.#isCurrent(state)) return;
      const nowMs = this.#clock.now();
      const draft = evaluateDiskTipAtIdle({
        availableBytes: due.disk?.availableBytes,
        workspaceDue: due.workspace !== undefined,
        weeklyTipAllowed,
        hasMintedFileHint: minted.length > 0,
        scanned,
        thresholdBytes: this.#workspaceThresholdBytes,
        lastWorkspaceTip: this.#workspaceTip.get(ownerAgentId),
        nowMs,
      });
      if (draft) {
        const tip = await this.#mint(ownerAgentId, {
          appId: SYSTEM_CLEANER_APP_ID,
          notificationClass: DISK_HINT.notificationClass,
          sourceRef: {
            kind: DISK_HINT.sourceKind,
            id: ownerAgentId,
            revision: String(state.config.revision),
          },
          title: draft.title,
          summary: draft.summary,
        });
        if (!this.#isCurrent(state)) return;
        if (tip) {
          minted.push(tip);
          this.#cleanupTipAtMs.set(ownerAgentId, nowMs);
          if (due.disk !== undefined) this.#diskTipAtMs.set(ownerAgentId, nowMs);
          if (draft.recordWorkspaceBytes !== undefined) {
            workspaceHeavy = true;
            this.#workspaceTip.set(ownerAgentId, {
              atMs: nowMs,
              bytes: draft.recordWorkspaceBytes,
            });
          }
        }
      }
    }
    const first = minted[0];
    if (!first) return;
    logger.info("System Cleaner hint presented", {
      event: "system_cleaner:presented",
      agent_id: ownerAgentId,
      item_ids: minted.map((item) => item.itemId),
      files: presentedFiles.map((file) => ({
        file: file.file,
        bytes: file.bytes,
        threshold_bytes: file.thresholdBytes,
      })),
      memory_wake_reason: due.memory,
      active_context_wake_reason: due.activeContext,
      knowledge_wake_reason: due.knowledge,
      disk_low: due.disk !== undefined,
      workspace_heavy: workspaceHeavy,
      workspace_wake_reason: due.workspace,
    });
    await this.options.wake(ownerAgentId, first.itemId);
  }

  async #presentFileHint(
    ownerAgentId: string,
    state: OwnerState,
    kind: FileKind,
  ): Promise<{ item: AgentAppItem; bytes: number; thresholdBytes: number } | undefined> {
    const hint = FILE_HINTS[kind];
    const measurement = await this.#measureFile(ownerAgentId, hint.path);
    if (!this.#isCurrent(state)) return undefined;
    const { intervalMs, revision } = state.config;
    const thresholdBytes = fileThresholdForConfig(state.config, kind);
    if (measurement.kind === "not_established" || measurement.bytes <= thresholdBytes) {
      this.#dropItems(ownerAgentId, hint.notificationClass);
      logger.info("System Cleaner due hint not presented", {
        event: "system_cleaner:present_skipped",
        agent_id: ownerAgentId,
        file: this.#filePath(ownerAgentId, kind),
        ...(measurement.kind === "not_established"
          ? { not_established: measurement.reason }
          : { bytes: measurement.bytes, threshold_bytes: thresholdBytes }),
      });
      return undefined;
    }
    if (
      !fileWakeReason(
        this.#fileHintPresented[kind].get(ownerAgentId),
        this.#clock.now(),
        measurement.bytes,
      )
    )
      return undefined;
    const draft = buildFileHintDraft(
      kind,
      measurement.bytes,
      thresholdBytes,
      intervalMs,
      measurement.incomplete,
    );
    const item = await this.#mint(ownerAgentId, {
      appId: SYSTEM_CLEANER_APP_ID,
      notificationClass: hint.notificationClass,
      sourceRef: { kind: hint.sourceKind, id: ownerAgentId, revision: String(revision) },
      title: draft.title,
      summary: draft.summary,
    });
    if (!item) return undefined;
    this.#fileHintPresented[kind].set(ownerAgentId, {
      atMs: this.#clock.now(),
      bytes: measurement.bytes,
    });
    return { item, bytes: measurement.bytes, thresholdBytes };
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

  #dropItems(ownerAgentId: string, notificationClass?: string): void {
    for (const kind of [...FILE_KINDS, "disk"] as const) {
      const itemClass = SYSTEM_CLEANER_CLASSES[kind].notificationClass;
      if (notificationClass !== undefined && notificationClass !== itemClass) continue;
      if (kind !== "disk") this.#fileHintPresented[kind].delete(ownerAgentId);
      this.#track(
        this.options.inbox.remove(ownerAgentId, systemCleanerItemId(itemClass, ownerAgentId)),
        ownerAgentId,
      );
    }
  }
}
