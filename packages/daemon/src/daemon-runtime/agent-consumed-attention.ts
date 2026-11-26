import { getLogger } from "@logtape/logtape";
import { mergeSeenExactSeqs, threadRootTarget } from "@lrm/coforge-sdk/internal";
import type { AgentConsumptionScope, AgentHistoryConsumptionScope } from "@lrm/coforge-sdk/agent";
import type {
  AgentConsumedSeqDelta,
  AgentConsumedSeqEntry,
  AgentConsumedSeqPort,
} from "#src/persistence/agent-consumed-seq-store";
import {
  displayConsumptionRoot,
  lookupConsumptionKey,
  matchesConsumptionScope,
  rememberConsumptionSpelling,
} from "./message-consumption-key";
import { LatestThreadReadIndex } from "./latest-thread-read-index";
import type { PreviewedWhole } from "./inbox-preview-rows";
import { noteFrontierSource, type FrontierSource } from "./agent-message-attention-frontier-source";
import {
  consumedReadBasis,
  consumedSnapshot,
  byNumber,
  containsSorted,
  firstAbove,
  isAscending,
  persistableConsumedTarget,
  restoreConsumedTargets,
  recordFullPreviews,
  scopeFullPreview,
  pruneFullPreviews,
  clearFullPreviews,
  sameThreadRoot,
  type AliasDelta,
  type ConsumedAgent,
  type ConsumedTarget,
} from "./agent-message-attention-index-helpers";

const logger = getLogger(["coforge", "daemon", "message-attention"]);
const NO_SEQUENCES: readonly number[] = [];

export class AgentConsumedAttention {
  readonly #consumedByAgent = new Map<string, ConsumedAgent>();
  readonly #conversationTargets = new Map<string, Map<string, Set<string>>>();
  readonly #attentionConversations = new Map<string, Map<string, Set<string>>>();
  readonly #latestThreadReads = new LatestThreadReadIndex();

  constructor(
    private readonly ports: {
      store(): AgentConsumedSeqPort | undefined;
      settlePending(
        agentId: string,
        target: string,
        conversationId: string | undefined,
        settled: (sequence: number) => boolean,
      ): void;
      onConsumed?(agentId: string): void;
    },
  ) {}

  peek(agentId: string, target: string, conversationId?: string): ConsumedTarget | undefined {
    const state = this.#consumedByAgent.get(agentId);
    if (!state || !conversationId) return state?.targets.get(target);
    const key = lookupConsumptionKey(state.scopeSpellings, conversationId, target);
    return state.scopes.get(key);
  }

  clearAgent(agentId: string): void {
    this.#consumedByAgent.delete(agentId);
    this.#latestThreadReads.clear(agentId);
    this.#conversationTargets.delete(agentId);
    this.#attentionConversations.delete(agentId);
  }

  recordExactSeen(agentId: string, shown: ReadonlyMap<string, readonly number[]>): void {
    this.#consumedState(agentId);
    const changedTargets: string[] = [];
    for (const [target, sequences] of shown) {
      if (!target || !this.#addExact(agentId, target, sequences)) continue;
      changedTargets.push(target);
      this.#settleSeen(agentId, target);
    }
    if (changedTargets.length > 0) this.#persistTargets(agentId, changedTargets);
  }
  recordHistoryRead(
    agentId: string,
    read: {
      spelling: string;
      target: string;
      shown: readonly number[];
      through: number;
      review?: {
        sequence: number;
      };
      scope?: Omit<AgentHistoryConsumptionScope, "agentId">;
    },
  ): void {
    this.#consumedState(agentId);
    const { target, scope } = read;
    const entry = this.#targetState(
      agentId,
      target,
      scope?.conversationId,
      scope?.threadRootId,
      false,
    );
    const aliasDelta = this.#setAlias(agentId, read.spelling, target);
    const hasScope =
      scope !== undefined && (scope.threadRootId !== undefined || !displayConsumptionRoot(target));
    let targetChanged = hasScope && !entry.serverScope;
    if (hasScope) entry.serverScope = true;
    if (read.through > 0)
      targetChanged =
        this.#advanceFrontier(agentId, target, read.through, "history_read", entry) ||
        targetChanged;
    targetChanged = this.#addExact(agentId, target, read.shown, entry) || targetChanged;
    this.#settleSeen(agentId, target, entry);
    if (read.review) {
      this.#takeReadOrder(agentId, target, read.review.sequence, entry);
      targetChanged = true;
    }
    if (read.scope) this.#settleScope(agentId, read.scope, read.shown, target);
    if (!aliasDelta && !targetChanged) return;
    this.#persistTargetAndAliases(
      agentId,
      targetChanged ? target : undefined,
      aliasDelta,
      entry,
      scope?.conversationId,
    );
  }
  recordSendContext(
    agentId: string,
    target: string,
    through: number,
    review?: {
      sequence: number;
    },
    authority?: AgentConsumptionScope,
    deliveryConversationId?: string,
  ): void {
    if (!Number.isInteger(through) || through < 1) return;
    if (authority && !matchesConsumptionScope(target, authority)) return;
    const conversationId = authority?.conversationId ?? deliveryConversationId;
    if (!conversationId) return;
    const entry = this.#targetState(
      agentId,
      target,
      conversationId,
      authority?.threadRootId,
      false,
    );
    const newAuthority = authority !== undefined && !entry.serverScope;
    if (newAuthority) entry.serverScope = true;
    const changed = this.#advanceFrontier(agentId, target, through, "send_context", entry);
    if (review) this.#takeReadOrder(agentId, target, review.sequence, entry);
    if (changed || review || newAuthority)
      this.#persistTargetAndAliases(agentId, target, undefined, entry, conversationId);
  }
  seenExactSequences(agentId: string, target: string, conversationId?: string): readonly number[] {
    this.#consumedState(agentId);
    const entry = this.peek(agentId, target, conversationId);
    return entry?.previewSeqs
      ? mergeSeenExactSeqs(entry.seq ?? 0, entry.exactSeqs ?? NO_SEQUENCES, entry.previewSeqs)
      : (entry?.exactSeqs ?? NO_SEQUENCES);
  }
  hasExactSeen(agentId: string, target: string): boolean {
    this.#consumedState(agentId);
    const entry = this.peek(agentId, target);
    return Boolean(entry?.exactSeqs?.length || entry?.previewSeqs?.length);
  }
  scopeFullPreview(agentId: string, preview: PreviewedWhole) {
    return scopeFullPreview(this.#consumedState(agentId), preview);
  }
  recordFullPreviews(agentId: string, shown: readonly PreviewedWhole[]): void {
    if (shown.length) recordFullPreviews(this.#consumedState(agentId), shown);
  }
  fullPreviewSequences(agentId: string, target: string, conversationId: string) {
    return this.peek(agentId, target, conversationId)?.previewSeqs;
  }
  clearPreviewSeen(agentId: string): void {
    clearFullPreviews(this.#consumedByAgent.get(agentId)?.scopes);
  }
  resolveTarget(agentId: string, target: string): string {
    return this.#consumedState(agentId).aliases.get(target) ?? target;
  }
  recordTargetAlias(agentId: string, spelling: string, canonical: string): void {
    this.#consumedState(agentId);
    const aliasDelta = this.#setAlias(agentId, spelling, canonical);
    if (aliasDelta) this.#persistDelta(agentId, aliasDelta);
  }
  hasSeen(agentId: string, target: string, sequence: number, conversationId?: string): boolean {
    return this.readBasis(agentId, target, sequence, conversationId) !== undefined;
  }
  readBasis(agentId: string, target: string, sequence: number, conversationId?: string) {
    this.#consumedState(agentId);
    return consumedReadBasis(this.peek(agentId, target, conversationId), sequence);
  }
  bindConversation(agentId: string, target: string, conversationId: string): void {
    const previous = this.#consumedState(agentId).targets.get(target);
    const wasUnbound = previous !== undefined && previous.conversationId === undefined;
    const entry = this.#targetState(agentId, target, conversationId);
    if (wasUnbound && entry === previous) {
      this.#persistTarget(agentId, target);
    }
  }
  #addExact(
    agentId: string,
    target: string,
    sequences: readonly number[],
    entry = this.#targetState(agentId, target),
  ): boolean {
    if (!sequences.length) return false;
    const existing = entry.exactSeqs ?? NO_SEQUENCES;
    const incoming = isAscending(sequences) ? sequences : [...sequences].sort(byNumber);
    const merged = mergeSeenExactSeqs(entry.seq ?? 0, existing, incoming);
    if (merged.length === existing.length && merged.every((value, i) => value === existing[i]))
      return false;
    entry.exactSeqs = merged;
    return true;
  }
  #advanceFrontier(
    agentId: string,
    target: string,
    sequence: number,
    source: FrontierSource,
    entry = this.#targetState(agentId, target),
  ): boolean {
    if (sequence <= (entry.seq ?? 0)) return false;
    entry.seq = sequence;
    noteFrontierSource(entry, source);
    const exact = entry.exactSeqs;
    if (exact?.length) {
      const kept = exact.slice(firstAbove(exact, sequence));
      if (!kept.length) delete entry.exactSeqs;
      else if (kept.length !== exact.length) entry.exactSeqs = kept;
    }
    pruneFullPreviews(entry, sequence);
    this.ports.settlePending(
      agentId,
      target,
      entry.conversationId,
      (pending) => pending <= sequence,
    );
    return true;
  }
  #settleSeen(agentId: string, target: string, entry = this.peek(agentId, target)): void {
    const frontier = entry?.seq ?? 0;
    const exact = entry?.exactSeqs;
    this.ports.settlePending(
      agentId,
      target,
      entry?.conversationId,
      (sequence) => sequence <= frontier || containsSorted(exact, sequence),
    );
  }
  #settleScope(
    agentId: string,
    scope: Omit<AgentHistoryConsumptionScope, "agentId">,
    shown: readonly number[],
    settled: string,
  ): void {
    if (shown.length === 0) return;
    const targets = this.#conversationTargets.get(agentId)?.get(scope.conversationId);
    if (!targets) return;
    const scopeRoot = scope.threadRootId ?? threadRootTarget(scope.target);
    if (scope.channelType === "thread" && scopeRoot === undefined) return;
    for (const target of targets) {
      if (target === settled) continue;
      const root = threadRootTarget(target);
      if (scope.channelType === "dm" ? root !== undefined : !sameThreadRoot(root, scopeRoot!))
        continue;
      this.ports.settlePending(agentId, target, scope.conversationId, (sequence) =>
        containsSorted(shown, sequence),
      );
    }
  }
  #setAlias(agentId: string, spelling: string, canonical: string): AliasDelta | undefined {
    if (!spelling || !canonical || spelling === canonical) return undefined;
    const { aliases } = this.#consumedState(agentId);
    let target = aliases.get(canonical) ?? canonical;
    let deletedCanonical: string | undefined;
    if (target === spelling) {
      aliases.delete(canonical);
      deletedCanonical = canonical;
      target = canonical;
    }
    if (aliases.get(spelling) === target) {
      return deletedCanonical !== undefined
        ? { upsertAliases: [], deleteAliases: [deletedCanonical] }
        : undefined;
    }
    aliases.set(spelling, target);
    const upsertAliases: { spelling: string; canonical: string }[] = [
      { spelling, canonical: target },
    ];
    for (const [other, named] of aliases) {
      if (named === spelling) {
        aliases.set(other, target);
        upsertAliases.push({ spelling: other, canonical: target });
      }
    }
    return deletedCanonical !== undefined
      ? { upsertAliases, deleteAliases: [deletedCanonical] }
      : { upsertAliases };
  }
  #takeReadOrder(
    agentId: string,
    target: string,
    sequence: number,
    entry = this.#targetState(agentId, target),
  ): void {
    const state = this.#consumedState(agentId);
    if (Number.isInteger(sequence) && sequence > 0)
      entry.reviewedSeq = Math.max(entry.reviewedSeq ?? 0, sequence);
    entry.readOrder = ++state.lastReadOrder;
    if (state.targets.get(target) === entry) this.#latestThreadReads.record(agentId, target, entry);
  }
  #persistDelta(agentId: string, delta?: AgentConsumedSeqDelta): void {
    const store = this.ports.store();
    if (store?.apply) {
      if (delta) store.apply(agentId, delta);
    } else if (store) {
      store.write(agentId, consumedSnapshot(this.#consumedState(agentId)));
    }
    this.ports.onConsumed?.(agentId);
  }
  #persistTarget(agentId: string, target: string): void {
    const store = this.ports.store();
    if (store) {
      const state = this.#consumedState(agentId);
      if (!store.apply) {
        store.write(agentId, consumedSnapshot(state));
      } else {
        const entry = state.targets.get(target);
        const record = entry?.conversationId ? persistableConsumedTarget(entry) : undefined;
        if (record) store.apply(agentId, { upsertTargets: [{ target, entry: record }] });
      }
    }
    this.ports.onConsumed?.(agentId);
  }
  #persistTargets(agentId: string, targets: readonly string[]): void {
    const store = this.ports.store();
    if (store) {
      const state = this.#consumedState(agentId);
      if (!store.apply) {
        store.write(agentId, consumedSnapshot(state));
      } else {
        const upsertTargets: { target: string; entry: AgentConsumedSeqEntry }[] = [];
        for (const target of targets) {
          const entry = state.targets.get(target);
          if (!entry?.conversationId) continue;
          const record = persistableConsumedTarget(entry);
          if (record) upsertTargets.push({ target, entry: record });
        }
        if (upsertTargets.length > 0) store.apply(agentId, { upsertTargets });
      }
    }
    this.ports.onConsumed?.(agentId);
  }
  #persistTargetAndAliases(
    agentId: string,
    target: string | undefined,
    aliasDelta: AliasDelta | undefined,
    scopedEntry: ConsumedTarget,
    conversationId?: string,
  ): void {
    const state = this.#consumedState(agentId);
    const record = scopedEntry.conversationId && persistableConsumedTarget(scopedEntry);
    const rows = target !== undefined && record ? [{ target, entry: record }] : undefined;
    const upsertTargets =
      target !== undefined && state.targets.get(target) === scopedEntry ? rows : undefined;
    const { threadRootId } = scopedEntry;
    const upsertScopedTargets =
      conversationId &&
      target !== undefined &&
      record &&
      (threadRootId || !displayConsumptionRoot(target))
        ? [{ target, entry: record, ...(threadRootId ? { threadRootId } : {}) }]
        : undefined;
    if (
      !upsertTargets &&
      !upsertScopedTargets &&
      !aliasDelta?.upsertAliases.length &&
      !aliasDelta?.deleteAliases?.length
    ) {
      this.#persistDelta(agentId);
      return;
    }
    const delta: AgentConsumedSeqDelta = {
      ...(upsertTargets ? { upsertTargets } : {}),
      ...(upsertScopedTargets ? { upsertScopedTargets } : {}),
      ...(aliasDelta?.upsertAliases.length ? { upsertAliases: aliasDelta.upsertAliases } : {}),
      ...(aliasDelta?.deleteAliases?.length ? { deleteAliases: aliasDelta.deleteAliases } : {}),
    };
    this.#persistDelta(agentId, delta);
  }
  modelSeenSequence(agentId: string, target: string, conversationId?: string): number {
    this.#consumedState(agentId);
    return this.peek(agentId, target, conversationId)?.seq ?? 0;
  }
  recordModelSeen(
    agentId: string,
    target: string,
    sequence: number,
    conversationId?: string,
  ): void {
    if (!Number.isInteger(sequence) || sequence < 1) return;
    const entry = this.#targetState(agentId, target, conversationId);
    if (this.#advanceFrontier(agentId, target, sequence, "model_seen", entry))
      this.#persistTargetAndAliases(agentId, target, undefined, entry, conversationId);
  }
  recordReadContext(agentId: string, target: string, sequence = 0): void {
    this.#takeReadOrder(agentId, target, sequence);
    this.#persistTarget(agentId, target);
  }
  readOrder(agentId: string, target: string): number | undefined {
    return this.#consumedState(agentId).targets.get(target)?.readOrder;
  }
  latestThreadReadUnderParent(
    agentId: string,
    parentTarget: string,
  ):
    | {
        target: string;
        order: number;
      }
    | undefined {
    return this.#latestThreadReads.get(agentId, parentTarget, this.#consumedState(agentId).targets);
  }
  #consumedState(agentId: string): ConsumedAgent {
    const existing = this.#consumedByAgent.get(agentId);
    if (existing) return existing;
    const state: ConsumedAgent = {
      targets: new Map(),
      scopes: new Map(),
      scopeSpellings: new Map(),
      aliases: new Map(),
      lastReadOrder: 0,
    };
    this.#consumedByAgent.set(agentId, state);
    const store = this.ports.store();
    if (store) {
      const saved = store.read(agentId);
      const readCursorCount = restoreConsumedTargets(state, saved);
      state.aliases = new Map(Object.entries(saved.aliases));
      state.lastReadOrder = saved.nextReadOrder - 1;
      if (readCursorCount > 0)
        logger.info("Agent read cursors restored from state", {
          event: "agent.message.consumed_cursors_restored",
          agent_id: agentId,
          daemon_pid: process.pid,
          target_count: readCursorCount,
        });
    }
    return state;
  }
  #targetState(
    agentId: string,
    target: string,
    conversationId?: string,
    threadRootId?: string,
    moveProjection = true,
  ): ConsumedTarget {
    const { targets, scopes, scopeSpellings } = this.#consumedState(agentId);
    const current = targets.get(target);
    if (!conversationId) {
      if (current) return current;
      const entry: ConsumedTarget = {};
      targets.set(target, entry);
      return entry;
    }

    const key =
      threadRootId === undefined
        ? lookupConsumptionKey(scopeSpellings, conversationId, target)
        : rememberConsumptionSpelling(scopeSpellings, conversationId, target, threadRootId);
    const existing = scopes.get(key);
    if (existing && !existing.previewOnly) {
      if (threadRootId !== undefined) existing.threadRootId = threadRootId;
      if (!current) targets.set(target, existing);
      return existing;
    }

    const entry = current && !current.conversationId ? current : (existing ?? {});
    if (existing?.previewOnly) {
      entry.previewSeqs = existing.previewSeqs;
      delete entry.previewOnly;
      pruneFullPreviews(entry, entry.seq ?? 0);
    }
    entry.conversationId = conversationId;
    if (threadRootId !== undefined) entry.threadRootId = threadRootId;
    scopes.set(key, entry);
    if (
      moveProjection ||
      !current?.conversationId ||
      (current.conversationId === conversationId && !current.threadRootId)
    ) {
      targets.set(target, entry);
      if (current && current !== entry) this.#latestThreadReads.clear(agentId);
    }
    return entry;
  }
  recordConversation(agentId: string, target: string, conversationId: string): void {
    const byTarget = this.#attentionConversations.get(agentId) ?? new Map<string, Set<string>>();
    const conversations = byTarget.get(target) ?? new Set<string>();
    if (conversations.has(conversationId)) return;
    conversations.add(conversationId);
    byTarget.set(target, conversations);
    this.#attentionConversations.set(agentId, byTarget);
    const byConversation = this.#conversationTargets.get(agentId) ?? new Map<string, Set<string>>();
    this.#conversationTargets.set(agentId, byConversation);
    const targets = byConversation.get(conversationId) ?? new Set<string>();
    targets.add(target);
    byConversation.set(conversationId, targets);
  }
  forgetConversation(agentId: string, target: string): void {
    const byTarget = this.#attentionConversations.get(agentId);
    const conversations = byTarget?.get(target);
    if (!conversations) return;
    byTarget?.delete(target);
    const byConversation = this.#conversationTargets.get(agentId);
    for (const conversationId of conversations) {
      const targets = byConversation?.get(conversationId);
      targets?.delete(target);
      if (targets?.size === 0) byConversation?.delete(conversationId);
    }
  }
}
