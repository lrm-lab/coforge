import { fstatSync, lstatSync, openSync, constants, closeSync, readSync } from "node:fs";
import { ContextViewStore, type ContextViewIndexEntry } from "./context-view-store";

export const CONTEXT_VIEW_SUPPORTED_RUNTIMES = [
  "claude",
  "codex",
  "kimi-sdk",
  "pi",
  "builtin",
] as const;
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
};

export type ContextViewAgentFacts = {
  agentId: string;
  runtime: string;
  sessionId?: string;
  transcript?: string;
  transcriptPath?: string;
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
  retentionDays?: number;
  now?: () => number;
  reportAvailability?: (availability: ContextViewAvailability) => void;
};

export class AgentContextViewService {
  readonly #stateDirectory: string;
  readonly #serverId: string;
  readonly #workspaceId: string;
  readonly #computerId: string;
  readonly #retentionDays: number;
  readonly #now: () => number;
  readonly #reportAvailability?: Options["reportAvailability"];
  readonly #stores = new Map<string, ContextViewStore>();
  readonly #reported = new Map<string, string>();
  readonly #retainedSince = new Map<string, string>();
  #maintenance?: ReturnType<typeof setInterval>;

  constructor(options: Options) {
    this.#stateDirectory = options.stateDirectory;
    this.#serverId = options.serverId;
    this.#workspaceId = options.workspaceId;
    this.#computerId = options.computerId;
    this.#retentionDays = options.retentionDays ?? 30;
    this.#now = options.now ?? Date.now;
    this.#reportAvailability = options.reportAvailability;
  }

  onMessageCommitted(facts: ContextViewAgentFacts, messageId: string, enabled: boolean): void {
    if (!enabled) return;
    const runtime = normalizeRuntime(facts.runtime);
    if (!runtime) {
      this.#report(facts, facts.runtime, false, "unsupported_runtime");
      return;
    }
    if (!facts.sessionId || !facts.transcript || !facts.transcriptPath) {
      this.#report(facts, runtime, false, "no_session");
      return;
    }
    const offset = this.#safeFileSize(facts.transcriptPath);
    if (offset === undefined || !this.#hasSupportedTranscript(facts.transcriptPath, runtime)) {
      this.#report(facts, runtime, false, "no_session");
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
    this.#report(facts, runtime, true);
  }

  reportAvailability(facts: ContextViewAgentFacts, enabled = true): void {
    if (!enabled) return;
    const runtime = normalizeRuntime(facts.runtime);
    if (!runtime) {
      this.#report(facts, facts.runtime, false, "unsupported_runtime");
    } else if (!facts.sessionId || !facts.transcript || !facts.transcriptPath) {
      this.#report(facts, runtime, false, "no_session");
    } else if (!this.#hasSupportedTranscript(facts.transcriptPath, runtime)) {
      this.#report(facts, runtime, false, "no_session");
    } else {
      this.#report(facts, runtime, true);
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
    for (const store of this.#stores.values()) {
      store.compact(this.#retentionDays);
      store.sweepOff(this.#now());
    }
  }

  startMaintenance(intervalMs = 60 * 60 * 1000): () => void {
    this.stopMaintenance();
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

  #report(
    facts: ContextViewAgentFacts,
    runtime: string,
    supported: boolean,
    unsupportedReason?: "unsupported_runtime" | "no_session",
  ): void {
    const retainedSince =
      (supported ? this.#store(facts.agentId).oldestSentAt() : undefined) ??
      this.#retainedSince.get(facts.agentId) ??
      new Date(this.#now()).toISOString();
    if (supported) this.#retainedSince.set(facts.agentId, retainedSince);
    const availability: ContextViewAvailability = {
      type: "agent:context_view_availability",
      protocolMajor: 1,
      workspaceId: this.#workspaceId,
      computerId: this.#computerId,
      agentId: facts.agentId,
      runtime,
      retentionDays: this.#retentionDays,
      supported,
      ...(supported ? { retainedSince } : { unsupportedReason }),
    };
    const encoded = JSON.stringify(availability);
    if (this.#reported.get(facts.agentId) === encoded) return;
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
