import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { lstat } from "node:fs/promises";
import {
  findProviderTranscript,
  providerTranscriptRoot,
  type ProviderTranscriptSource,
} from "./context-view-provider-locator";
import {
  CONTEXT_VIEW_PROVIDERS,
  contextViewRuntime,
  type ContextViewRuntime,
} from "./context-view-providers";
import {
  CONTEXT_VIEW_READ_FLAGS,
  ContextViewStore,
  type ContextViewIndexEntry,
} from "./context-view-store";

export const AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_MAX_MS = 24 * 60 * 60 * 1000;
export const AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_JITTER_MS = 4 * 60 * 60 * 1000;
const SUPPORT_SCAN_BYTES = 8 * 1024 * 1024;
const SUPPORT_SCAN_CHUNK_BYTES = 64 * 1024;
const TRANSCRIPT_CACHE_MAX_ENTRIES = 256;

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

type CachedProviderTranscript = {
  runtime: string;
  root: string;
  sessionId: string;
  source: ProviderTranscriptSource;
};

type CachedTranscriptSupport =
  | {
      supported: true;
      runtime: ContextViewRuntime;
      dev: number;
      ino: number;
      markerOffset: number;
    }
  | {
      supported: false;
      runtime: ContextViewRuntime;
      dev: number;
      ino: number;
      size: number;
      mtimeMs: number;
      ctimeMs: number;
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
  locateProviderTranscript?: typeof findProviderTranscript;
};

async function isLiveRegularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return !info.isSymbolicLink() && info.isFile() && info.nlink === 1;
  } catch {
    return false;
  }
}

export class AgentContextViewService {
  readonly #stateDirectory: string;
  readonly #serverId: string;
  readonly #workspaceId: string;
  readonly #computerId: string;
  readonly #retentionDays: number;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #reportAvailability?: Options["reportAvailability"];
  readonly #locateProviderTranscript: typeof findProviderTranscript;
  readonly #stores = new Map<string, ContextViewStore>();
  readonly #reported = new Map<string, string>();
  readonly #availabilityFacts = new Map<
    string,
    { facts: ContextViewAgentFacts; enabled: boolean; lastReportedAt: number }
  >();
  readonly #providerTranscripts = new Map<string, CachedProviderTranscript>();
  readonly #transcriptCache = new Map<string, CachedTranscriptSupport>();
  readonly #scanBuffer = Buffer.allocUnsafe(SUPPORT_SCAN_CHUNK_BYTES);
  readonly #markerProbe = Buffer.allocUnsafe(64);
  #providerTranscriptGeneration = 0;
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
    this.#locateProviderTranscript = options.locateProviderTranscript ?? findProviderTranscript;
  }

  async resolveProviderTranscript(
    agentId: string,
    runtime: string,
    sessionId: string,
    envVars?: Readonly<Record<string, string>>,
  ): Promise<ProviderTranscriptSource | undefined> {
    if (contextViewRuntime(runtime) === undefined) return undefined;
    const root = providerTranscriptRoot(runtime, envVars);
    const generation = this.#providerTranscriptGeneration;
    let expected = this.#providerTranscripts.get(agentId);
    if (
      expected &&
      root !== undefined &&
      expected.runtime === runtime &&
      expected.root === root &&
      expected.sessionId === sessionId
    ) {
      if (await isLiveRegularFile(expected.source.absolute)) return expected.source;
      if (
        this.#providerTranscriptGeneration === generation &&
        this.#providerTranscripts.get(agentId) === expected
      ) {
        this.#providerTranscripts.delete(agentId);
        expected = undefined;
      }
    }
    const located = await this.#locateProviderTranscript(runtime, sessionId, envVars);
    if (
      this.#providerTranscriptGeneration === generation &&
      this.#providerTranscripts.get(agentId) === expected
    ) {
      if (located && root !== undefined) {
        this.#providerTranscripts.set(agentId, { runtime, root, sessionId, source: located });
      } else if (expected) {
        this.#providerTranscripts.delete(agentId);
      }
    }
    return located;
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
    const inspected = this.#inspectTranscript(facts.transcriptPath, runtime);
    if (!inspected?.supported) {
      this.#report(facts, runtime, false, "no_session", "message");
      return;
    }
    const entry: ContextViewIndexEntry = {
      messageId,
      sentAt: new Date(this.#now()).toISOString(),
      runtime,
      sessionId: facts.sessionId,
      transcript: facts.transcript,
      offset: inspected.size,
    };
    const retainedSince = this.#store(facts.agentId).record(entry);
    this.#report(facts, runtime, true, undefined, "message", false, retainedSince);
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
      !this.#inspectTranscript(facts.transcriptPath, runtime)?.supported &&
      !this.#hasRetainedIndex(facts.agentId)
    ) {
      this.#report(facts, runtime, false, "no_session", trigger, force);
    } else {
      this.#report(facts, runtime, true, undefined, trigger, force);
    }
  }

  disable(agentId: string): void {
    this.#providerTranscriptGeneration += 1;
    this.#providerTranscripts.delete(agentId);
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
        this.#providerTranscriptGeneration += 1;
        this.#providerTranscripts.delete(agentId);
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
    knownRetainedSince?: string,
  ): void {
    const retainedSince = supported
      ? (knownRetainedSince ?? this.#store(facts.agentId).oldestSentAt())
      : undefined;
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

  #rememberTranscript(path: string, entry: CachedTranscriptSupport): void {
    if (
      !this.#transcriptCache.has(path) &&
      this.#transcriptCache.size >= TRANSCRIPT_CACHE_MAX_ENTRIES
    ) {
      const oldest = this.#transcriptCache.keys().next().value;
      if (oldest !== undefined) this.#transcriptCache.delete(oldest);
    }
    this.#transcriptCache.set(path, entry);
  }

  #inspectTranscript(
    path: string,
    runtime: ContextViewRuntime,
  ): { size: number; supported: boolean } | undefined {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.nlink > 1) {
        this.#transcriptCache.delete(path);
        return undefined;
      }
      const fd = openSync(path, CONTEXT_VIEW_READ_FLAGS);
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1) {
          this.#transcriptCache.delete(path);
          return undefined;
        }
        const dev = Number(info.dev);
        const ino = Number(info.ino);
        const size = Number(info.size);
        const marker = CONTEXT_VIEW_PROVIDERS[runtime].marker;
        const cached = this.#transcriptCache.get(path);
        if (cached && cached.runtime === runtime && cached.dev === dev && cached.ino === ino) {
          if (cached.supported) {
            if (
              cached.markerOffset + marker.length <= size &&
              cached.markerOffset + marker.length <= SUPPORT_SCAN_BYTES
            ) {
              const probe =
                marker.length <= this.#markerProbe.length
                  ? this.#markerProbe
                  : Buffer.allocUnsafe(marker.length);
              const bytesRead = readSync(fd, probe, 0, marker.length, cached.markerOffset);
              if (bytesRead === marker.length && probe.subarray(0, marker.length).equals(marker)) {
                return { size, supported: true };
              }
            }
          } else if (
            cached.size === size &&
            cached.mtimeMs === Number(info.mtimeMs) &&
            cached.ctimeMs === Number(info.ctimeMs)
          ) {
            return { size, supported: false };
          }
          this.#transcriptCache.delete(path);
        }

        const markerOffset = this.#findMarkerOffset(fd, Math.min(size, SUPPORT_SCAN_BYTES), marker);
        if (markerOffset !== undefined) {
          this.#rememberTranscript(path, { supported: true, runtime, dev, ino, markerOffset });
          return { size, supported: true };
        }
        this.#rememberTranscript(path, {
          supported: false,
          runtime,
          dev,
          ino,
          size,
          mtimeMs: Number(info.mtimeMs),
          ctimeMs: Number(info.ctimeMs),
        });
        return { size, supported: false };
      } finally {
        closeSync(fd);
      }
    } catch {
      this.#transcriptCache.delete(path);
      return undefined;
    }
  }

  #findMarkerOffset(fd: number, limit: number, marker: Buffer): number | undefined {
    if (limit < marker.length) return undefined;
    const overlap = Math.max(0, marker.length - 1);
    let fileOffset = 0;
    let carry = 0;
    while (fileOffset < limit) {
      const toRead = Math.min(this.#scanBuffer.length - carry, limit - fileOffset);
      const bytesRead = readSync(fd, this.#scanBuffer, carry, toRead, fileOffset);
      if (bytesRead === 0) break;
      const valid = carry + bytesRead;
      const hit = this.#scanBuffer.subarray(0, valid).indexOf(marker);
      if (hit !== -1) return fileOffset - carry + hit;
      fileOffset += bytesRead;
      if (fileOffset < limit && overlap > 0) {
        const nextCarry = Math.min(overlap, valid);
        this.#scanBuffer.copyWithin(0, valid - nextCarry, valid);
        carry = nextCarry;
      } else {
        carry = 0;
      }
    }
    return undefined;
  }
}
