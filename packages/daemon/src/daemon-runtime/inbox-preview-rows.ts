import { SEEN_EXACT_SEQS_LIMIT, type AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { messageConsumptionKey } from "./message-consumption-key";
import { inboxPreviewLine, previewShowsWholeMessage } from "./inbox-preview";

/** The fields a notice row reads — a live delivery or a recovery message. A recovery message
 * names no body, so it never contributes a preview. */
export type NoticeRowItem = Pick<AgentMessageDelivery, "messageId" | "target" | "sequence"> &
  Partial<
    Pick<
      AgentMessageDelivery,
      | "agentId"
      | "conversationId"
      | "body"
      | "latestSenderKind"
      | "latestSenderHandle"
      | "attachmentCount"
      | "source"
      | "mentionDelivery"
      | "reason"
    >
  >;

export type NoticeRow = {
  target: string;
  newIds: Set<string>;
  heldIds: Set<string>;
  /** Up to the preview limit, newest last, for the bodies a notice may show. */
  previews: { messageId: string; line: string }[];
};

/** A message whose whole body a notice showed: the model does not need it again. */
export type PreviewedWhole = { target: string; conversationId: string; sequence: number };

/**
 * One row per target, in the order the targets first appear, with the previews the notice may
 * show under each. A message already previewed in full stops counting toward its target's
 * numbers. Recovery renders no previews: it is a wakeup, not a second copy of the bodies.
 */
export function buildNoticeRows(input: {
  announced: readonly NoticeRowItem[];
  queued: readonly NoticeRowItem[];
  agentId: string | undefined;
  previewLimit: number;
  previewedInFull(delivery: NoticeRowItem): boolean;
  alreadyConsumed?(delivery: NoticeRowItem): boolean;
}): { rows: NoticeRow[]; whole: PreviewedWhole[] } {
  const announcedIds = new Set(input.announced.map((delivery) => delivery.messageId));
  const byTarget = new Map<string, NoticeRow>();
  const previewCandidates = new Map<
    string,
    Array<{
      messageId: string;
      sequence: number;
      line: string;
      conversationId?: string;
      whole: boolean;
    }>
  >();
  const rowFor = (target: string) => {
    const existing = byTarget.get(target);
    if (existing) return existing;
    const created: NoticeRow = { target, newIds: new Set(), heldIds: new Set(), previews: [] };
    byTarget.set(target, created);
    return created;
  };
  const skip = (delivery: NoticeRowItem) =>
    !delivery.target ||
    Boolean(
      input.agentId && (input.previewedInFull(delivery) || input.alreadyConsumed?.(delivery)),
    );
  const place = (delivery: NoticeRowItem, ids: Set<string>) => {
    if (!delivery.target) return;
    ids.add(delivery.messageId);
    if (!input.previewLimit) return;
    const line = inboxPreviewLine(delivery);
    if (!line) return;
    const candidates = previewCandidates.get(delivery.target) ?? [];
    candidates.push({
      messageId: delivery.messageId,
      sequence: delivery.sequence,
      line,
      conversationId: delivery.conversationId,
      whole: previewShowsWholeMessage(delivery),
    });
    previewCandidates.set(delivery.target, candidates);
  };
  for (const delivery of input.announced) {
    if (skip(delivery)) continue;
    place(delivery, rowFor(delivery.target!).newIds);
  }
  for (const delivery of input.queued) {
    if (skip(delivery) || announcedIds.has(delivery.messageId)) continue;
    place(delivery, rowFor(delivery.target!).heldIds);
  }
  const whole: PreviewedWhole[] = [];
  for (const row of byTarget.values()) {
    // The newest few, shown oldest first so the line reads in the order they arrived.
    const newest = (previewCandidates.get(row.target) ?? [])
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, input.previewLimit)
      .reverse();
    row.previews = newest.map(({ messageId, line }) => ({ messageId, line }));
    // Only a preview the notice actually rendered counts as shown.
    for (const candidate of newest)
      if (candidate.whole && candidate.conversationId)
        whole.push({
          target: row.target,
          conversationId: candidate.conversationId,
          sequence: candidate.sequence,
        });
  }
  return { rows: [...byTarget.values()], whole };
}

/** One line per target, its previews indented under it. */
export function renderNoticeRows(rows: readonly NoticeRow[]): string[] {
  return rows.map((row) => {
    const parts: string[] = [];
    if (row.newIds.size)
      parts.push(`${row.newIds.size} new message${row.newIds.size === 1 ? "" : "s"}`);
    if (row.heldIds.size)
      parts.push(`${row.heldIds.size} held message${row.heldIds.size === 1 ? "" : "s"}`);
    const line = `${row.target} ${parts.join(" · ")}`;
    return row.previews.length
      ? [line, ...row.previews.map(({ line }) => `  ${line}`)].join("\n")
      : line;
  });
}

export class PreviewSeen {
  readonly #byAgent = new Map<string, Map<string, Set<number>>>();

  has(
    agentId: string,
    target: string,
    sequence: number,
    conversationId: string | undefined,
  ): boolean {
    return this.recorded(agentId, target, conversationId)?.has(sequence) ?? false;
  }

  recorded(
    agentId: string,
    target: string,
    conversationId: string | undefined,
  ): ReadonlySet<number> | undefined {
    if (!conversationId) return undefined;
    return this.#byAgent.get(agentId)?.get(messageConsumptionKey(conversationId, target));
  }

  record(agentId: string, shown: readonly PreviewedWhole[]): void {
    if (!shown.length) return;
    const byScope = this.#byAgent.get(agentId) ?? new Map<string, Set<number>>();
    const touched = new Set<string>();
    for (const { target, conversationId, sequence } of shown) {
      const key = messageConsumptionKey(conversationId, target);
      const seen = byScope.get(key) ?? new Set<number>();
      seen.add(sequence);
      byScope.set(key, seen);
      touched.add(key);
    }
    for (const key of touched) {
      const seen = byScope.get(key);
      if (seen && seen.size > SEEN_EXACT_SEQS_LIMIT) {
        const kept = [...seen].sort((left, right) => left - right).slice(-SEEN_EXACT_SEQS_LIMIT);
        byScope.set(key, new Set(kept));
      }
    }
    this.#byAgent.set(agentId, byScope);
  }

  pruneThrough(
    agentId: string,
    target: string,
    frontier: number,
    conversationId: string | undefined,
  ): void {
    if (!conversationId) return;
    const byScope = this.#byAgent.get(agentId);
    const key = messageConsumptionKey(conversationId, target);
    const seen = byScope?.get(key);
    if (!byScope || !seen) return;
    for (const sequence of seen) if (sequence <= frontier) seen.delete(sequence);
    if (seen.size === 0) {
      byScope.delete(key);
      if (byScope.size === 0) this.#byAgent.delete(agentId);
    }
  }

  clear(agentId: string): void {
    this.#byAgent.delete(agentId);
  }

  mergeExact(
    agentId: string,
    target: string,
    recorded: readonly number[] | undefined,
    limit: number,
    conversationId: string | undefined,
  ): readonly number[] | undefined {
    const previewed = this.recorded(agentId, target, conversationId);
    if (!previewed?.size) return recorded;
    const values = recorded?.length ? [...new Set([...recorded, ...previewed])] : [...previewed];
    return values.sort((left, right) => left - right).slice(-limit);
  }
}
