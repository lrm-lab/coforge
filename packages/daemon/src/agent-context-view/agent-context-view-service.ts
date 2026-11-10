import { fstatSync, lstatSync, openSync, constants, closeSync, readSync } from "node:fs";
import { ContextViewStore, type ContextViewIndexEntry } from "./context-view-store";
import {
  CONTEXT_VIEW_PROVIDERS,
  contextViewRuntime,
  type ContextViewRuntime,
} from "./context-view-providers";

export const AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_MAX_MS = 24 * 60 * 60 * 1000;
export const AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_JITTER_MS = 4 * 60 * 60 * 1000;
const SUPPORT_SCAN_BYTES = 8 * 1024 * 1024;

export function agentContextViewAvailabilityRefreshDelay(random = Math.random): number {
  const sample = Math.min(0.999999, Math.max(0, random()));
  return Math.floor(
    AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_MAX_MS -
      AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_JITTER_MS +
      sample * AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_JITTER_MS,
  );
}

export type ContextViewAvailability = {
  type: "agent:context_view_availability";
  protocolMajor: 1;
  workspaceId: string;
  computerId: string;
  agentId: string;
  runtime: string;
  retainedSince?: string;
  retentionDays: number;
  supported: boolean;
  unsupportedReason?: "unsupported_runtime" | "no_session";
  trigger?: "startup" | "message" | "server_features" | "periodic" | "retention";
};

export type ContextViewAgentFacts = {
  agentId: string;
  runtime: string;
  sessionId?: string;
  transcript?: string;
  transcriptPath?: string;
  contextViewRequestLogPath?: string;
};

type Options = {
  stateDirectory: string;
  serverId: string;
  workspaceId: string;
  computerId: string;
  workspaceRoot?: string;
  retentionDays?: number;
  now?: () => number;
  random?: () => number;
  reportAvailability?: (availability: ContextViewAvailability) => void;
};

export class AgentContextViewService {
  readonly #stateDirectory: string;
  readonly #serverId: string;
  readonly #workspaceId: string;
  readonly #computerId: string;
  readonly #retentionDays: number;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #reportAvailability?: Options["reportAvailability"];
  readonly #stores = new Map<string, ContextViewStore>();
  readonly #reported = new Map<string, string>();
  readonly #availabilityFacts = new Map<
    string,
    { facts: ContextViewAgentFacts; enabled: boolean; lastReportedAt: number }
  >();
  #maintenance?: ReturnType<typeof setInterval>;
  #availabilityRefreshTimer?: ReturnType<typeof setTimeout>;
  #maintenanceActive = false;

  constructor(options: Options) {
    this.#stateDirectory = options.stateDirectory;
    this.#serverId = options.serverId;
    this.#workspaceId = options.workspaceId;
    this.#computerId = options.computerId;
    this.#retentionDays = options.retentionDays ?? 30;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#reportAvailability = options.reportAvailability;
  }

  onMessageCommitted(facts: ContextViewAgentFacts, messageId: string, enabled: boolean): void {
    if (!enabled) return;
    const runtime = contextViewRuntime(facts.runtime);
    if (!runtime) {
      this.#report(facts, facts.runtime, false, "unsupported_runtime", "message");
      return;
    }
    if (!facts.sessionId || !facts.transcript || !facts.transcriptPath) {
      this.#report(facts, runtime, false, "no_session", "message");
      return;
    }
    const offset = this.#safeFileSize(facts.transcriptPath);
    if (offset === undefined || !this.#hasSupportedTranscript(facts.transcriptPath, runtime)) {
      this.#report(facts, runtime, false, "no_session", "message");
      return;
    }
    const entry: ContextViewIndexEntry = {
      messageId,
      sentAt: new Date(this.#now()).toISOString(),
      runtime,
      sessionId: facts.sessionId,
      transcript: facts.transcript,
      offset,
    };
    this.#store(facts.agentId).record(entry);
    this.#report(facts, runtime, true, undefined, "message");
  }

  reportAvailability(
    facts: ContextViewAgentFacts,
    enabled = true,
    trigger: ContextViewAvailability["trigger"] = "startup",
    force = false,
  ): void {
    this.#availabilityFacts.set(facts.agentId, {
      facts,
      enabled,
      lastReportedAt: this.#now(),
    });
    if (!enabled) return;
    const runtime = contextViewRuntime(facts.runtime);
    if (!runtime) {
      this.#report(facts, facts.runtime, false, "unsupported_runtime", trigger, force);
    } else if (
      (!facts.sessionId || !facts.transcript || !facts.transcriptPath) &&
      !this.#hasRetainedIndex(facts.agentId)
    ) {
      this.#report(facts, runtime, false, "no_session", trigger, force);
    } else if (
      facts.transcriptPath &&
      !this.#hasSupportedTranscript(facts.transcriptPath, runtime) &&
      !this.#hasRetainedIndex(facts.agentId)
    ) {
      this.#report(facts, runtime, false, "no_session", trigger, force);
    } else {
      this.#report(facts, runtime, true, undefined, trigger, force);
    }
  }

  disable(agentId: string): void {
    if (ContextViewStore.exists(this.#stateDirectory, this.#serverId, agentId))
      this.#store(agentId).markOff(this.#now());
  }

  enable(agentId: string): void {
    if (ContextViewStore.exists(this.#stateDirectory, this.#serverId, agentId))
      this.#store(agentId).clearOff();
  }

  compactAndSweep(): void {
    for (const agentId of ContextViewStore.agentIds(this.#stateDirectory, this.#serverId))
      this.#store(agentId);
    for (const [agentId, store] of this.#stores) {
      const compacted = store.compactWithStats(this.#retentionDays);
      const off = store.sweepOff(this.#now());
      if (off) {
        this.#stores.delete(agentId);
        continue;
      }
      store.sweepRequestLogs(this.#now() - this.#retentionDays * 24 * 60 * 60 * 1000);
      if (compacted.dropped > 0) {
        const availability = this.#availabilityFacts.get(agentId);
        if (availability?.enabled)
          this.reportAvailability(availability.facts, true, "retention", true);
      }
    }
    const now = this.#now();
    for (const [agentId, state] of this.#availabilityFacts) {
      if (now - state.lastReportedAt < AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_MAX_MS) continue;
      state.lastReportedAt = now;
      this.reportAvailability(state.facts, state.enabled, "periodic", true);
      this.#availabilityFacts.set(agentId, state);
    }
  }

  startMaintenance(intervalMs = 60 * 60 * 1000): () => void {
    this.stopMaintenance();
    this.#maintenanceActive = true;
    this.compactAndSweep();
    this.#scheduleAvailabilityRefresh();
    this.#maintenance = setInterval(() => this.compactAndSweep(), intervalMs);
    this.#maintenance.unref?.();
    return () => this.stopMaintenance();
  }

  stopMaintenance(): void {
    this.#maintenanceActive = false;
    if (this.#maintenance !== undefined) clearInterval(this.#maintenance);
    this.#maintenance = undefined;
    if (this.#availabilityRefreshTimer !== undefined) clearTimeout(this.#availabilityRefreshTimer);
    this.#availabilityRefreshTimer = undefined;
  }

  #scheduleAvailabilityRefresh(): void {
    if (!this.#maintenanceActive || this.#availabilityRefreshTimer !== undefined) return;
    this.#availabilityRefreshTimer = setTimeout(() => {
      this.#availabilityRefreshTimer = undefined;
      if (!this.#maintenanceActive) return;
      for (const state of this.#availabilityFacts.values())
        this.reportAvailability(state.facts, state.enabled, "periodic", true);
      this.#scheduleAvailabilityRefresh();
    }, agentContextViewAvailabilityRefreshDelay(this.#random));
    this.#availabilityRefreshTimer.unref?.();
  }

  find(agentId: string, messageId: string): ContextViewIndexEntry | undefined {
    if (!ContextViewStore.exists(this.#stateDirectory, this.#serverId, agentId)) return undefined;
    const store = this.#store(agentId);
    return store.isOff() ? undefined : store.find(messageId);
  }

  requestLogDirectory(agentId: string): string {
    return this.#store(agentId).requestLogDirectory;
  }

  #store(agentId: string): ContextViewStore {
    let store = this.#stores.get(agentId);
    if (!store) {
      store = new ContextViewStore(this.#stateDirectory, this.#serverId, agentId, this.#now);
      this.#stores.set(agentId, store);
    }
    return store;
  }

  #report(
    facts: ContextViewAgentFacts,
    runtime: string,
    supported: boolean,
    unsupportedReason?: "unsupported_runtime" | "no_session",
    trigger: ContextViewAvailability["trigger"] = "startup",
    force = false,
  ): void {
    const retainedSince = supported ? this.#store(facts.agentId).oldestSentAt() : undefined;
    const availability: ContextViewAvailability = {
      type: "agent:context_view_availability",
      protocolMajor: 1,
      workspaceId: this.#workspaceId,
      computerId: this.#computerId,
      agentId: facts.agentId,
      runtime,
      retentionDays: this.#retentionDays,
      supported,
      trigger,
      ...(supported ? (retainedSince ? { retainedSince } : {}) : { unsupportedReason }),
    };
    const encoded = JSON.stringify(availability);
    if (!force && this.#reported.get(facts.agentId) === encoded) return;
    this.#reported.set(facts.agentId, encoded);
    this.#reportAvailability?.(availability);
  }

  #hasRetainedIndex(agentId: string): boolean {
    if (!ContextViewStore.exists(this.#stateDirectory, this.#serverId, agentId)) return false;
    const store = this.#store(agentId);
    return !store.isOff() && store.oldestSentAt() !== undefined;
  }

  #safeFileSize(path: string): number | undefined {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.nlink > 1) return undefined;
      const fd = openSync(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      try {
        const info = fstatSync(fd);
        return info.isFile() && info.nlink === 1 ? info.size : undefined;
      } finally {
        closeSync(fd);
      }
    } catch {
      return undefined;
    }
  }

  #hasSupportedTranscript(path: string, runtime: ContextViewRuntime): boolean {
    try {
      const fd = openSync(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1) return false;
        const size = Math.min(info.size, SUPPORT_SCAN_BYTES);
        const buffer = Buffer.alloc(size);
        let read = 0;
        while (read < size) {
          const count = readSync(fd, buffer, read, size - read, read);
          if (count === 0) break;
          read += count;
        }
        return buffer.subarray(0, read).includes(CONTEXT_VIEW_PROVIDERS[runtime].marker);
      } finally {
        closeSync(fd);
      }
    } catch {
      return false;
    }
  }
}
