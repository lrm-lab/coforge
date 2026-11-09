import { fstatSync, lstatSync, openSync, constants, closeSync, readSync } from "node:fs";
import { relative } from "node:path";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { ContextViewStore, type ContextViewIndexEntry } from "./context-view-store";

export const CONTEXT_VIEW_SUPPORTED_RUNTIMES = [
  "claude",
  RUNTIME_PROVIDER.CODEX,
  "kimi-sdk",
  "pi",
  "builtin",
] as const;
export const AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_MAX_MS = 24 * 60 * 60 * 1000;
export type ContextViewRuntime = (typeof CONTEXT_VIEW_SUPPORTED_RUNTIMES)[number];
const SUPPORT_SCAN_BYTES = 8 * 1024 * 1024;
const SUPPORT_MARKERS: Record<ContextViewRuntime, Buffer> = {
  claude: Buffer.from('"type":"api-request"', "utf8"),
  codex: Buffer.from('"type":"additional_tools"', "utf8"),
  "kimi-sdk": Buffer.from('"type":"llm.request"', "utf8"),
  pi: Buffer.from('{"type":"request",', "utf8"),
  builtin: Buffer.from('{"type":"request",', "utf8"),
};

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
  trigger?: "startup" | "message" | "server_features";
};

export type ContextViewAgentFacts = {
  agentId: string;
  runtime: string;
  sessionId?: string;
  transcript?: string;
  transcriptPath?: string;
  contextViewRequestLogPath?: string;
};

function normalizeRuntime(value: string): ContextViewRuntime | undefined {
  return (CONTEXT_VIEW_SUPPORTED_RUNTIMES as readonly string[]).includes(value)
    ? (value as ContextViewRuntime)
    : undefined;
}

type Options = {
  stateDirectory: string;
  serverId: string;
  workspaceId: string;
  computerId: string;
  workspaceRoot?: string;
  retentionDays?: number;
  now?: () => number;
  reportAvailability?: (availability: ContextViewAvailability) => void;
};

export class AgentContextViewService {
  readonly #stateDirectory: string;
  readonly #serverId: string;
  readonly #workspaceId: string;
  readonly #computerId: string;
  readonly #workspaceRoot?: string;
  readonly #retentionDays: number;
  readonly #now: () => number;
  readonly #reportAvailability?: Options["reportAvailability"];
  readonly #stores = new Map<string, ContextViewStore>();
  readonly #reported = new Map<string, string>();
  readonly #retainedSince = new Map<string, string>();
  readonly #requestLogs = new Map<string, string>();
  readonly #availabilityFacts = new Map<
    string,
    { facts: ContextViewAgentFacts; enabled: boolean; lastReportedAt: number }
  >();
  #maintenance?: ReturnType<typeof setInterval>;

  constructor(options: Options) {
    this.#stateDirectory = options.stateDirectory;
    this.#serverId = options.serverId;
    this.#workspaceId = options.workspaceId;
    this.#computerId = options.computerId;
    this.#workspaceRoot = options.workspaceRoot;
    this.#retentionDays = options.retentionDays ?? 30;
    this.#now = options.now ?? Date.now;
    this.#reportAvailability = options.reportAvailability;
  }

  onMessageCommitted(facts: ContextViewAgentFacts, messageId: string, enabled: boolean): void {
    this.#rememberRequestLog(facts);
    if (!enabled) return;
    const runtime = normalizeRuntime(facts.runtime);
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
    this.#rememberRequestLog(facts);
    this.#availabilityFacts.set(facts.agentId, {
      facts,
      enabled,
      lastReportedAt: this.#now(),
    });
    if (!enabled) return;
    const runtime = normalizeRuntime(facts.runtime);
    if (!runtime) {
      this.#report(facts, facts.runtime, false, "unsupported_runtime", trigger, force);
    } else if (!facts.sessionId || !facts.transcript || !facts.transcriptPath) {
      this.#report(facts, runtime, false, "no_session", trigger, force);
    } else if (!this.#hasSupportedTranscript(facts.transcriptPath, runtime)) {
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
    for (const store of this.#stores.values()) {
      store.compact(this.#retentionDays);
      const agentId = [...this.#stores.entries()].find(([, candidate]) => candidate === store)?.[0];
      const off = store.sweepOff(this.#now());
      const requestLog = agentId ? this.#requestLogs.get(agentId) : undefined;
      if (requestLog) {
        if (off) ContextViewStore.removeRequestLog(requestLog);
        else
          ContextViewStore.sweepRequestLog(
            requestLog,
            this.#now() - this.#retentionDays * 24 * 60 * 60 * 1000,
          );
      }
    }
    const now = this.#now();
    for (const [agentId, state] of this.#availabilityFacts) {
      if (now - state.lastReportedAt < AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_MAX_MS) continue;
      state.lastReportedAt = now;
      this.reportAvailability(state.facts, state.enabled, "startup", true);
      this.#availabilityFacts.set(agentId, state);
    }
  }

  startMaintenance(intervalMs = 60 * 60 * 1000): () => void {
    this.stopMaintenance();
    this.compactAndSweep();
    this.#maintenance = setInterval(() => this.compactAndSweep(), intervalMs);
    this.#maintenance.unref?.();
    return () => this.stopMaintenance();
  }

  stopMaintenance(): void {
    if (this.#maintenance !== undefined) clearInterval(this.#maintenance);
    this.#maintenance = undefined;
  }

  find(agentId: string, messageId: string): ContextViewIndexEntry | undefined {
    if (!ContextViewStore.exists(this.#stateDirectory, this.#serverId, agentId)) return undefined;
    const store = this.#store(agentId);
    return store.isOff() ? undefined : store.find(messageId);
  }

  #store(agentId: string): ContextViewStore {
    let store = this.#stores.get(agentId);
    if (!store) {
      store = new ContextViewStore(this.#stateDirectory, this.#serverId, agentId, this.#now);
      this.#stores.set(agentId, store);
    }
    return store;
  }

  #rememberRequestLog(facts: ContextViewAgentFacts): void {
    const path = facts.contextViewRequestLogPath;
    if (!path) return;
    if (this.#workspaceRoot) {
      const relativePath = relative(this.#workspaceRoot, path);
      if (!relativePath || relativePath.startsWith("..") || relativePath.includes("\0")) return;
    }
    this.#requestLogs.set(facts.agentId, path);
  }

  #report(
    facts: ContextViewAgentFacts,
    runtime: string,
    supported: boolean,
    unsupportedReason?: "unsupported_runtime" | "no_session",
    trigger: ContextViewAvailability["trigger"] = "startup",
    force = false,
  ): void {
    const retainedSince =
      (supported ? this.#store(facts.agentId).oldestSentAt() : undefined) ??
      this.#retainedSince.get(facts.agentId);
    if (supported && retainedSince) this.#retainedSince.set(facts.agentId, retainedSince);
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
        return buffer.subarray(0, read).includes(SUPPORT_MARKERS[runtime]);
      } finally {
        closeSync(fd);
      }
    } catch {
      return false;
    }
  }
}
