import { getLogger } from "@logtape/logtape";
import {
  SEEN_EXACT_SEQS_LIMIT,
  mergeSeenExactSeqs,
  threadRootTarget,
} from "@lrm/coforge-sdk/internal";
import type { AgentHistoryConsumptionScope } from "@lrm/coforge-sdk/agent";
import type {
  AgentConsumedSeqDelta,
  AgentConsumedSeqEntry,
  AgentConsumedSeqPort,
} from "#src/persistence/agent-consumed-seq-store";
import { LatestThreadReadIndex } from "./latest-thread-read-index";
import type { PreviewSeen } from "./inbox-preview-rows";
import { noteFrontierSource, type FrontierSource } from "./agent-message-attention-frontier-source";
import {
  consumedReadBasis,
  consumedSnapshot,
  byNumber,
  containsSorted,
  firstAbove,
  isAscending,
  persistableConsumedTarget,
  sameThreadRoot,
  type ConsumedAgent,
  type ConsumedTarget,
} from "./agent-message-attention-index-helpers";

const logger = getLogger(["coforge", "daemon", "message-attention"]);
const NO_SEQUENCES: readonly number[] = [];

type AliasDelta = Readonly<{
  upsertAliases: readonly Readonly<{ spelling: string; canonical: string }>[];
  deleteAliases?: readonly string[];
}>;

export class AgentConsumedAttention {
  readonly #consumedByAgent = new Map<string, ConsumedAgent>();
  readonly #conversationTargets = new Map<string, Map<string, Set<string>>>();
  readonly #attentionConversation = new Map<string, Map<string, string>>();
  readonly #latestThreadReads = new LatestThreadReadIndex();

  constructor(
    private readonly ports: {
      store(): AgentConsumedSeqPort | undefined;
      previewSeen: PreviewSeen;
      settlePending(agentId: string, target: string, settled: (sequence: number) => boolean): void;
    },
  ) {}

  peek(agentId: string): ConsumedAgent | undefined {
    return this.#consumedByAgent.get(agentId);
  }

  clearAgent(agentId: string): void {
    this.#consumedByAgent.delete(agentId);
    this.#latestThreadReads.clear(agentId);
    this.#conversationTargets.delete(agentId);
    this.#attentionConversation.delete(agentId);
    this.ports.previewSeen.clear(agentId);
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
      scope?: Pick<AgentHistoryConsumptionScope, "conversationId" | "channelType" | "target">;
    },
  ): void {
    this.#consumedState(agentId);
    const { target } = read;
    const aliasDelta = this.#setAlias(agentId, read.spelling, target);
    let targetChanged = false;
    if (read.through > 0)
      targetChanged =
        this.#advanceFrontier(agentId, target, read.through, "history_read") || targetChanged;
    targetChanged = this.#addExact(agentId, target, read.shown) || targetChanged;
    this.#settleSeen(agentId, target);
    if (read.review) {
      this.#takeReadOrder(agentId, target, read.review.sequence);
      targetChanged = true;
    }
    if (read.scope) this.#settleScope(agentId, read.scope, read.shown, target);
    if (!aliasDelta && !targetChanged) return;
    this.#persistTargetAndAliases(agentId, targetChanged ? target : undefined, aliasDelta);
  }
  recordSendContext(
    agentId: string,
    target: string,
    through: number,
    review?: {
      sequence: number;
    },
  ): void {
    if (!Number.isInteger(through) || through < 1) return;
    const changed = this.#advanceFrontier(agentId, target, through, "send_context");
    if (review) this.#takeReadOrder(agentId, target, review.sequence);
    if (changed || review) this.#persistTarget(agentId, target);
  }
  seenExactSequences(agentId: string, target: string): readonly number[] {
    return (
      this.ports.previewSeen.mergeExact(
        agentId,
        target,
        this.#consumedState(agentId).targets.get(target)?.exactSeqs,
        SEEN_EXACT_SEQS_LIMIT,
      ) ?? NO_SEQUENCES
    );
  }
  hasExactSeen(agentId: string, target: string): boolean {
    return (
      (this.#consumedState(agentId).targets.get(target)?.exactSeqs?.length ?? 0) > 0 ||
      (this.ports.previewSeen.recorded(agentId, target)?.size ?? 0) > 0
    );
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
    const entry = this.#consumedState(agentId).targets.get(target);
    if (conversationId !== undefined && entry?.conversationId !== conversationId) return;
    return consumedReadBasis(entry, sequence);
  }
  bindConversation(agentId: string, target: string, conversationId: string): void {
    const entry = this.#targetState(agentId, target);
    const recorded = entry.conversationId;
    if (recorded === conversationId) return;
    entry.conversationId = conversationId;
    if (recorded !== undefined) {
      logger.info("Agent consumed cursor reset for a recreated conversation", {
        event: "agent.message.consumed_cursor_reset",
        agent_id: agentId,
        target,
        previous_conversation_id: recorded,
        conversation_id: conversationId,
        model_seen_seq: entry.seq ?? 0,
      });
      delete entry.seq;
      delete entry.exactSeqs;
      delete entry.reviewedSeq;
      noteFrontierSource(entry, "reset");
      this.#latestThreadReads.clear(agentId);
      this.ports.previewSeen.clearTarget(agentId, target);
      const record = persistableConsumedTarget(entry);
      this.#persistDelta(
        agentId,
        record?.conversationId
          ? { upsertTargets: [{ target, entry: record }] }
          : { deleteTargets: [target] },
      );
      return;
    }
    const record = persistableConsumedTarget(entry);
    if (record?.conversationId)
      this.#persistDelta(agentId, { upsertTargets: [{ target, entry: record }] });
  }
  #addExact(agentId: string, target: string, sequences: readonly number[]): boolean {
    if (!sequences.length) return false;
    const entry = this.#targetState(agentId, target);
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
  ): boolean {
    const entry = this.#targetState(agentId, target);
    if (sequence <= (entry.seq ?? 0)) return false;
    entry.seq = sequence;
    noteFrontierSource(entry, source);
    const exact = entry.exactSeqs;
    if (exact?.length) {
      const kept = exact.slice(firstAbove(exact, sequence));
      if (!kept.length) delete entry.exactSeqs;
      else if (kept.length !== exact.length) entry.exactSeqs = kept;
    }
    this.ports.previewSeen.pruneThrough(agentId, target, sequence);
    this.ports.settlePending(agentId, target, (pending) => pending <= sequence);
    return true;
  }
  #settleSeen(agentId: string, target: string): void {
    const entry = this.#consumedState(agentId).targets.get(target);
    const frontier = entry?.seq ?? 0;
    const exact = entry?.exactSeqs;
    this.ports.settlePending(
      agentId,
      target,
      (sequence) => sequence <= frontier || containsSorted(exact, sequence),
    );
  }
  #settleScope(
    agentId: string,
    scope: Pick<AgentHistoryConsumptionScope, "conversationId" | "channelType" | "target">,
    shown: readonly number[],
    settled: string,
  ): void {
    if (shown.length === 0) return;
    const targets = this.#conversationTargets.get(agentId)?.get(scope.conversationId);
    if (!targets) return;
    const scopeRoot = threadRootTarget(scope.target);
    if (scope.channelType === "thread" && scopeRoot === undefined) return;
    for (const target of targets) {
      if (target === settled) continue;
      const root = threadRootTarget(target);
      if (scope.channelType === "dm" ? root !== undefined : !sameThreadRoot(root, scopeRoot!))
        continue;
      this.ports.settlePending(agentId, target, (sequence) => containsSorted(shown, sequence));
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
  #takeReadOrder(agentId: string, target: string, sequence: number): void {
    const state = this.#consumedState(agentId);
    const entry = this.#targetState(agentId, target);
    if (Number.isInteger(sequence) && sequence > 0)
      entry.reviewedSeq = Math.max(entry.reviewedSeq ?? 0, sequence);
    entry.readOrder = ++state.lastReadOrder;
    this.#latestThreadReads.record(agentId, target, entry);
  }
  #persistDelta(agentId: string, delta: AgentConsumedSeqDelta): void {
    const store = this.ports.store();
    if (!store) return;
    if (store.apply) {
      store.apply(agentId, delta);
      return;
    }
    store.write(agentId, consumedSnapshot(this.#consumedState(agentId)));
  }
  #persistTarget(agentId: string, target: string): void {
    const store = this.ports.store();
    if (!store) return;
    const state = this.#consumedState(agentId);
    if (!store.apply) {
      store.write(agentId, consumedSnapshot(state));
      return;
    }
    const entry = state.targets.get(target);
    if (!entry?.conversationId) return;
    const record = persistableConsumedTarget(entry);
    if (!record) return;
    store.apply(agentId, { upsertTargets: [{ target, entry: record }] });
  }
  #persistTargets(agentId: string, targets: readonly string[]): void {
    const store = this.ports.store();
    if (!store) return;
    const state = this.#consumedState(agentId);
    if (!store.apply) {
      store.write(agentId, consumedSnapshot(state));
      return;
    }
    const upsertTargets: { target: string; entry: AgentConsumedSeqEntry }[] = [];
    for (const target of targets) {
      const entry = state.targets.get(target);
      if (!entry?.conversationId) continue;
      const record = persistableConsumedTarget(entry);
      if (record) upsertTargets.push({ target, entry: record });
    }
    if (upsertTargets.length > 0) store.apply(agentId, { upsertTargets });
  }
  #persistTargetAndAliases(
    agentId: string,
    target: string | undefined,
    aliasDelta: AliasDelta | undefined,
  ): void {
    const store = this.ports.store();
    if (!store) return;
    const state = this.#consumedState(agentId);
    if (!store.apply) {
      store.write(agentId, consumedSnapshot(state));
      return;
    }
    let upsertTargets: { target: string; entry: AgentConsumedSeqEntry }[] | undefined;
    if (target !== undefined) {
      const entry = state.targets.get(target);
      if (entry?.conversationId) {
        const record = persistableConsumedTarget(entry);
        if (record) upsertTargets = [{ target, entry: record }];
      }
    }
    if (
      !upsertTargets?.length &&
      !aliasDelta?.upsertAliases.length &&
      !aliasDelta?.deleteAliases?.length
    )
      return;
    store.apply(agentId, {
      ...(upsertTargets ? { upsertTargets } : {}),
      ...(aliasDelta?.upsertAliases.length ? { upsertAliases: aliasDelta.upsertAliases } : {}),
      ...(aliasDelta?.deleteAliases?.length ? { deleteAliases: aliasDelta.deleteAliases } : {}),
    });
  }
  modelSeenSequence(agentId: string, target: string): number {
    return this.#consumedState(agentId).targets.get(target)?.seq ?? 0;
  }
  recordModelSeen(agentId: string, target: string, sequence: number): void {
    if (!Number.isInteger(sequence) || sequence < 1) return;
    if (this.#advanceFrontier(agentId, target, sequence, "model_seen"))
      this.#persistTarget(agentId, target);
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
    const state: ConsumedAgent = { targets: new Map(), aliases: new Map(), lastReadOrder: 0 };
    this.#consumedByAgent.set(agentId, state);
    const store = this.ports.store();
    if (store) {
      const saved = store.read(agentId);
      let readCursorCount = 0;
      for (const [target, entry] of Object.entries(saved.targets)) {
        state.targets.set(target, { ...entry });
        if ((entry.seq ?? 0) > 0 || entry.exactSeqs?.length) readCursorCount++;
      }
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
  #targetState(agentId: string, target: string): ConsumedTarget {
    const { targets } = this.#consumedState(agentId);
    const existing = targets.get(target);
    if (existing) return existing;
    const entry: ConsumedTarget = {};
    targets.set(target, entry);
    return entry;
  }
  recordConversation(agentId: string, target: string, conversationId: string): void {
    const byTarget = this.#attentionConversation.get(agentId) ?? new Map<string, string>();
    this.#attentionConversation.set(agentId, byTarget);
    if (byTarget.get(target) === conversationId) return;
    byTarget.set(target, conversationId);
    const byConversation = this.#conversationTargets.get(agentId) ?? new Map<string, Set<string>>();
    this.#conversationTargets.set(agentId, byConversation);
    const targets = byConversation.get(conversationId) ?? new Set<string>();
    targets.add(target);
    byConversation.set(conversationId, targets);
  }
  forgetConversation(agentId: string, target: string): void {
    const byTarget = this.#attentionConversation.get(agentId);
    const conversationId = byTarget?.get(target);
    if (conversationId === undefined) return;
    byTarget!.delete(target);
    const byConversation = this.#conversationTargets.get(agentId);
    const targets = byConversation?.get(conversationId);
    targets?.delete(target);
    if (targets?.size === 0) byConversation!.delete(conversationId);
  }
}
