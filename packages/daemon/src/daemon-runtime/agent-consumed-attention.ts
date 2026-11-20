import { getLogger } from "@logtape/logtape";
import {
  SEEN_EXACT_SEQS_LIMIT,
  mergeSeenExactSeqs,
  threadRootTarget,
} from "@lrm/coforge-sdk/internal";
import type { AgentHistoryConsumptionScope } from "@lrm/coforge-sdk/agent";
import type { AgentConsumedSeqPort } from "#src/persistence/agent-consumed-seq-store";
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
  sameThreadRoot,
  type ConsumedAgent,
  type ConsumedTarget,
} from "./agent-message-attention-index-helpers";

const logger = getLogger(["coforge", "daemon", "message-attention"]);
const NO_SEQUENCES: readonly number[] = [];

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
  }

  recordExactSeen(agentId: string, shown: ReadonlyMap<string, readonly number[]>): void {
    this.#consumedState(agentId);
    let changed = false;
    for (const [target, sequences] of shown) {
      if (!target || !this.#addExact(agentId, target, sequences)) continue;
      changed = true;
      this.#settleSeen(agentId, target);
    }
    if (changed) this.#persist(agentId);
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
    let changed = this.#setAlias(agentId, read.spelling, target);
    if (read.through > 0)
      changed = this.#advanceFrontier(agentId, target, read.through, "history_read") || changed;
    changed = this.#addExact(agentId, target, read.shown) || changed;
    this.#settleSeen(agentId, target);
    if (read.review) {
      this.#takeReadOrder(agentId, target, read.review.sequence);
      changed = true;
    }
    if (read.scope) this.#settleScope(agentId, read.scope, read.shown, target);
    if (changed) this.#persist(agentId);
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
    if (changed || review) this.#persist(agentId);
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
    if (this.#setAlias(agentId, spelling, canonical)) this.#persist(agentId);
  }
  hasSeen(agentId: string, target: string, sequence: number): boolean {
    return this.readBasis(agentId, target, sequence) !== undefined;
  }
  readBasis(agentId: string, target: string, sequence: number) {
    return consumedReadBasis(this.#consumedState(agentId).targets.get(target), sequence);
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
    }
    this.#persist(agentId);
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
  #setAlias(agentId: string, spelling: string, canonical: string): boolean {
    if (!spelling || !canonical || spelling === canonical) return false;
    const { aliases } = this.#consumedState(agentId);
    let target = aliases.get(canonical) ?? canonical;
    if (target === spelling) {
      aliases.delete(canonical);
      target = canonical;
    }
    if (aliases.get(spelling) === target) return false;
    aliases.set(spelling, target);
    for (const [other, named] of aliases) if (named === spelling) aliases.set(other, target);
    return true;
  }
  #takeReadOrder(agentId: string, target: string, sequence: number): void {
    const state = this.#consumedState(agentId);
    const entry = this.#targetState(agentId, target);
    if (Number.isInteger(sequence) && sequence > 0)
      entry.reviewedSeq = Math.max(entry.reviewedSeq ?? 0, sequence);
    entry.readOrder = ++state.lastReadOrder;
    this.#latestThreadReads.record(agentId, target, entry);
  }
  #persist(agentId: string): void {
    const store = this.ports.store();
    if (!store) return;
    const state = this.#consumedState(agentId);
    store.write(agentId, consumedSnapshot(state));
  }
  modelSeenSequence(agentId: string, target: string): number {
    return this.#consumedState(agentId).targets.get(target)?.seq ?? 0;
  }
  recordModelSeen(agentId: string, target: string, sequence: number): void {
    if (!Number.isInteger(sequence) || sequence < 1) return;
    if (this.#advanceFrontier(agentId, target, sequence, "model_seen")) this.#persist(agentId);
  }
  recordReadContext(agentId: string, target: string, sequence = 0): void {
    this.#takeReadOrder(agentId, target, sequence);
    this.#persist(agentId);
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
