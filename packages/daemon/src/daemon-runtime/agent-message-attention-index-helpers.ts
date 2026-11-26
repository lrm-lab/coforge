import { lookupConsumptionKey, rememberConsumptionSpelling } from "./message-consumption-key";
import type { AgentMessageDelivery, MessageSenderKind } from "@lrm/coforge-sdk/internal";
import type { PreviewedWhole } from "./inbox-preview-rows";
import type { NoticeGeneration } from "./agent-wakeup-unavailable-error";
import { HELD_CONTEXT_LIMIT, mergeSeenExactSeqs } from "@lrm/coforge-sdk/internal";
import type {
  AgentConsumedSeqEntry,
  AgentConsumedSeqState,
} from "#src/persistence/agent-consumed-seq-store";

export const byNumber = (left: number, right: number) => left - right;

export function isAscending(values: readonly number[]): boolean {
  for (let i = 1; i < values.length; i++) if (values[i]! < values[i - 1]!) return false;
  return true;
}

/** The index of the first value above `bound` in an ascending list. */
export function firstAbove(values: readonly number[], bound: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! <= bound) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Whether two thread roots name the same message: compared without case, and a short (8-hex)
 * root names the full root it begins. */
export function sameThreadRoot(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === b || (a.length < b.length ? b.startsWith(a) : a.startsWith(b));
}

/** Whether an ascending list holds `value`. */
export function containsSorted(values: readonly number[] | undefined, value: number): boolean {
  if (!values?.length) return false;
  const index = firstAbove(values, value - 1);
  return values[index] === value;
}

export type ConsumedReadBasis = "read_frontier" | "exact_read";

export function consumedReadBasis(
  entry: { seq?: number; exactSeqs?: readonly number[] } | undefined,
  sequence: number,
): ConsumedReadBasis | undefined {
  if ((entry?.seq ?? 0) >= sequence) return "read_frontier";
  if (containsSorted(entry?.exactSeqs, sequence)) return "exact_read";
}

/** The deliveries that carry news about a message the Agent itself authored: its action card was
 * answered, completed, or declined (`choice`) or expired (`expired`). The read state that already
 * covers the card cannot cover the event, so these always deserve a notice. */
const CARD_EVENT_REASONS: ReadonlySet<string> = new Set(["choice", "expired"]);

export function isCardEvent(message: { reason?: string }): boolean {
  return message.reason !== undefined && CARD_EVENT_REASONS.has(message.reason);
}

/**
 * Delivery and message ids remembered per Agent for duplicate suppression. The
 * oldest are forgotten first; a redelivery older than this window is treated
 * as new, which only costs one extra inbox notice.
 */
export const REMEMBERED_DELIVERIES = 4096;

/** How many of the newest unreviewed deliveries per target the index keeps for a locally decided
 * freshness hold to show: exactly `HELD_CONTEXT_LIMIT` (in the SDK's `freshness-decision.ts`),
 * because the hold shows the newest that many and no more — and anything older is consumed by the
 * same frontier anyway. No invented slack. */
export const PENDING_WINDOW_LIMIT = HELD_CONTEXT_LIMIT;

/** One unreviewed delivery plus the moment this daemon learned about it. Deliveries carry no
 * message timestamp of their own (only the server knows when a message was written), so the
 * arrival time is what a locally built preview can honestly show. */
export type PendingWindowEntry = { delivery: AgentMessageDelivery; receivedAt: number };

/** Whether `receive` already recorded this delivery's attention: its id is in the remembered
 * window, or it is held (see `NoticeGeneration.recordedHeld`). */
export function attentionRecorded(
  generation: { seenDeliveryIds: ReadonlySet<string>; recordedHeld: ReadonlySet<string> },
  deliveryId: string,
): boolean {
  return generation.seenDeliveryIds.has(deliveryId) || generation.recordedHeld.has(deliveryId);
}

/**
 * Releases the batch after flush. Settlements include deliveries already consumed or announced,
 * so acceptance evidence comes only from the deliveries this flush handed to the runtime.
 */
export function markFlushed(
  generation: NoticeGeneration,
  settled: readonly AgentMessageDelivery[],
  announced: readonly AgentMessageDelivery[],
): void {
  markNoticeAccepted(generation, announced);
  for (const { deliveryId } of settled) {
    if (generation.seenDeliveryIds.has(deliveryId)) generation.notified.add(deliveryId);
    generation.recordedHeld.delete(deliveryId);
  }
}

/**
 * Marks deliveries as notified once a notice of them was accepted. `notified` only holds ids the
 * remembered window still holds, as `#remember` prunes it, so a notice accepted after the window
 * moved past its delivery, or a backlog flushed past the window, leaves no id behind that nothing
 * would ever forget.
 */
export function markNoticeAccepted(
  generation: NoticeGeneration,
  accepted: readonly { deliveryId: string }[],
): void {
  for (const { deliveryId } of accepted) {
    if (!generation.seenDeliveryIds.has(deliveryId)) continue;
    generation.notified.add(deliveryId);
    generation.acceptedDeliveryIds.add(deliveryId);
  }
}

export type MessageAttention = Readonly<{
  target: string;
  pendingCount: number;
  firstPendingSequence: number;
  latestSequence: number;
  latestCreatedAtMs?: number;
  latestSenderKind?: MessageSenderKind;
  latestSenderHandle?: string;
  flags: readonly string[];
}>;

export type AliasDelta = Readonly<{
  upsertAliases: readonly Readonly<{ spelling: string; canonical: string }>[];
  deleteAliases?: readonly string[];
}>;

export type ConsumedAgent = {
  targets: Map<string, ConsumedTarget>;
  scopes: Map<string, ConsumedTarget>;
  scopeSpellings: Map<string, string | null>;
  aliases: Map<string, string>;
  lastReadOrder: number;
};
/** Exact sequences stay sorted above the frontier. reviewedSeq advances only for presented
 * review context, independently of consumption; readOrder compares reviews across targets. */
export type ConsumedTarget = {
  -readonly [K in keyof AgentConsumedSeqEntry]: AgentConsumedSeqEntry[K];
} & {
  threadRootId?: string;
  serverScope?: boolean;
  previewSeqs?: readonly number[];
  previewOnly?: true;
};

export function scopeFullPreview(state: ConsumedAgent, preview: PreviewedWhole): PreviewedWhole {
  const { conversationId, target } = preview;
  return {
    ...preview,
    scopeKey: lookupConsumptionKey(state.scopeSpellings, conversationId, target),
  };
}

export function recordFullPreviews(state: ConsumedAgent, shown: readonly PreviewedWhole[]): void {
  const batches = new Map<ConsumedTarget, number[]>();
  for (const { target, conversationId, sequence, scopeKey } of shown) {
    if (!conversationId) continue;
    const key = lookupConsumptionKey(state.scopeSpellings, conversationId, target);
    if (scopeKey !== undefined && scopeKey !== key) continue;
    let entry = state.scopes.get(key);
    if (sequence <= (entry?.seq ?? 0)) continue;
    if (!entry) {
      entry = { conversationId, previewOnly: true };
      state.scopes.set(key, entry);
    }
    const batch = batches.get(entry);
    if (batch) batch.push(sequence);
    else batches.set(entry, [sequence]);
  }
  for (const [entry, sequences] of batches) {
    entry.previewSeqs = mergeSeenExactSeqs(
      entry.seq ?? 0,
      entry.previewSeqs ?? [],
      sequences.sort(byNumber),
    );
  }
}

export function clearFullPreviews(scopes: ConsumedAgent["scopes"] | undefined): void {
  if (!scopes) return;
  for (const [key, entry] of scopes) {
    if (entry.previewOnly) scopes.delete(key);
    else delete entry.previewSeqs;
  }
}

export function pruneFullPreviews(entry: ConsumedTarget, sequence: number): void {
  if (!entry.previewSeqs) return;
  const first = firstAbove(entry.previewSeqs, sequence);
  if (first === entry.previewSeqs.length) delete entry.previewSeqs;
  else if (first > 0) entry.previewSeqs = entry.previewSeqs.slice(first);
}

export function persistableConsumedTarget(
  entry: ConsumedTarget,
): AgentConsumedSeqEntry | undefined {
  if (entry.seq === undefined && entry.readOrder === undefined && !entry.exactSeqs?.length)
    return undefined;
  const record: ConsumedTarget = {};
  if (entry.seq !== undefined) record.seq = entry.seq;
  if (entry.readOrder !== undefined) {
    record.readOrder = entry.readOrder;
    if (entry.reviewedSeq !== undefined) record.reviewedSeq = entry.reviewedSeq;
  }
  if (entry.exactSeqs?.length) record.exactSeqs = entry.exactSeqs;
  if (entry.conversationId !== undefined) record.conversationId = entry.conversationId;
  return record;
}

export function consumedSnapshot(state: ConsumedAgent): AgentConsumedSeqState {
  const targets: Record<string, AgentConsumedSeqEntry> = {};
  for (const [target, entry] of state.targets) {
    const record = persistableConsumedTarget(entry);
    if (record) targets[target] = record;
  }
  return {
    targets,
    aliases: Object.fromEntries(state.aliases),
    nextReadOrder: state.lastReadOrder + 1,
  };
}

export function restoreConsumedTargets(state: ConsumedAgent, saved: AgentConsumedSeqState): number {
  let count = 0;
  for (const { target, threadRootId, entry } of saved.scopedTargets ?? []) {
    if (!entry.conversationId) continue;
    const key = rememberConsumptionSpelling(
      state.scopeSpellings,
      entry.conversationId,
      target,
      threadRootId,
    );
    state.scopes.set(key, { ...entry, threadRootId, serverScope: true });
    if ((entry.seq ?? 0) > 0 || entry.exactSeqs?.length) count++;
  }
  for (const [target, entry] of Object.entries(saved.targets)) {
    const key =
      entry.conversationId &&
      lookupConsumptionKey(state.scopeSpellings, entry.conversationId, target);
    const restored = (key ? state.scopes.get(key) : undefined) ?? { ...entry };
    state.targets.set(target, restored);
    if (saved.scopedTargets === undefined) {
      if (key) state.scopes.set(key, restored);
      if ((entry.seq ?? 0) > 0 || entry.exactSeqs?.length) count++;
    }
  }
  return count;
}
