import {
  decodeMemoryDispositionRequest,
  type MemoryDispositionRecord,
  type MemoryDispositionResult,
} from "@lrm/coforge-sdk/agent";

/** Frozen delivery provenance. No excerpt/content is returned on an ACL failure. */
export type MemoryHintSource = {
  citationId: string;
  accountId: string;
  uri: string;
  contentHash?: string;
  contentVersion?: string;
};

export type DeliveredMemoryHint = {
  id: string;
  targetAgentId: string;
  deliveredAt: Date | null;
  expiresAt: Date;
  sources: readonly MemoryHintSource[];
};

export type MemoryDispositionTransaction = {
  hint: DeliveredMemoryHint | null;
  latest: MemoryDispositionRecord | null;
  append(
    record: MemoryDispositionRecord,
    readableSources: readonly MemoryHintSource[],
  ): Promise<void>;
};

export type MemoryDispositionStore = {
  /** Implementations serialize the entire callback per workspace + hint, including ACL reads. */
  withHint<T>(
    workspaceId: string,
    hintId: string,
    action: (transaction: MemoryDispositionTransaction) => Promise<T>,
  ): Promise<T>;
};

export function createMemoryDispositions(deps: {
  store: MemoryDispositionStore;
  isMemoryAgent(workspaceId: string, agentId: string): Promise<boolean>;
  canReadSource(workspaceId: string, agentId: string, source: MemoryHintSource): Promise<boolean>;
  now?: () => Date;
}) {
  return {
    async submit(
      workspaceId: string,
      agentId: string,
      value: unknown,
    ): Promise<MemoryDispositionResult> {
      let request;
      try {
        request = decodeMemoryDispositionRequest(value);
      } catch {
        return { ok: false, error: { code: "invalid_argument" } };
      }
      const input = request;
      return deps.store.withHint(workspaceId, input.hint_id, async ({ hint, latest, append }) => {
        if (
          !hint ||
          !hint.deliveredAt ||
          hint.targetAgentId !== agentId ||
          (await deps.isMemoryAgent(workspaceId, agentId))
        )
          return { ok: false, error: { code: "unauthorized" } };
        if (latest) {
          if (latest.decision === input.decision)
            return { ok: true, record: latest, duplicate: true };
          if (latest.decision !== "defer") return { ok: false, error: { code: "terminal" } };
        }
        const now = (deps.now ?? (() => new Date()))();
        if (now >= hint.expiresAt) return { ok: false, error: { code: "expired" } };
        if (!input.reason.trim()) return { ok: false, error: { code: "invalid_argument" } };
        const readable: MemoryHintSource[] = [];
        const skipped: string[] = [];
        for (const source of hint.sources) {
          if (await deps.canReadSource(workspaceId, agentId, source)) readable.push(source);
          else skipped.push(source.citationId);
        }
        if (!readable.length)
          return { ok: false, error: { code: "not_actionable", source_refs: skipped } };
        const decidedAt = (deps.now ?? (() => new Date()))();
        if (decidedAt >= hint.expiresAt) return { ok: false, error: { code: "expired" } };
        const record: MemoryDispositionRecord = {
          hint_id: hint.id,
          target_agent_id: agentId,
          decision: input.decision,
          reason: input.reason,
          intended_action_refs: input.intended_action_refs ?? [],
          decided_at: decidedAt.toISOString(),
          skipped_source_refs: skipped,
        };
        await append(record, readable);
        return { ok: true, record, duplicate: false };
      });
    },
  };
}
