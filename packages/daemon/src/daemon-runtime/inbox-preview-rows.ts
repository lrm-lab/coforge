import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { inboxPreviewLine, previewShowsWholeMessage } from "./inbox-preview";

/** The fields a notice row reads — a live delivery or a recovery message. A recovery message
 * names no body, so it never contributes a preview. */
export type NoticeRowItem = Pick<AgentMessageDelivery, "messageId" | "target" | "sequence"> &
  Partial<
    Pick<
      AgentMessageDelivery,
      | "agentId"
      | "body"
      | "latestSenderKind"
      | "latestSenderHandle"
      | "attachmentCount"
      | "source"
      | "mentionDelivery"
    >
  >;

export type NoticeRow = {
  target: string;
  newIds: Set<string>;
  heldIds: Set<string>;
  /** Up to the preview limit, newest last, for the bodies a notice may show. */
  previews: string[];
};

/** A message whose whole body a notice showed: the model does not need it again. */
export type PreviewedWhole = { target: string; sequence: number };

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
  previewedInFull(target: string, sequence: number): boolean;
}): { rows: NoticeRow[]; whole: PreviewedWhole[] } {
  const announcedIds = new Set(input.announced.map((delivery) => delivery.messageId));
  const byTarget = new Map<string, NoticeRow>();
  const previewCandidates = new Map<
    string,
    Array<{ sequence: number; line: string; whole: boolean }>
  >();
  const rowFor = (target: string) => {
    const existing = byTarget.get(target);
    if (existing) return existing;
    const created: NoticeRow = { target, newIds: new Set(), heldIds: new Set(), previews: [] };
    byTarget.set(target, created);
    return created;
  };
  const place = (delivery: NoticeRowItem, ids: Set<string>) => {
    if (!delivery.target) return;
    if (input.agentId && input.previewedInFull(delivery.target, delivery.sequence)) return;
    ids.add(delivery.messageId);
    if (!input.previewLimit) return;
    const line = inboxPreviewLine(delivery);
    if (!line) return;
    const candidates = previewCandidates.get(delivery.target) ?? [];
    candidates.push({
      sequence: delivery.sequence,
      line,
      whole: previewShowsWholeMessage(delivery),
    });
    previewCandidates.set(delivery.target, candidates);
  };
  for (const delivery of input.announced)
    if (delivery.target) place(delivery, rowFor(delivery.target).newIds);
  for (const delivery of input.queued) {
    if (!delivery.target || announcedIds.has(delivery.messageId)) continue;
    place(delivery, rowFor(delivery.target).heldIds);
  }
  const whole: PreviewedWhole[] = [];
  for (const row of byTarget.values()) {
    // The newest few, shown oldest first so the line reads in the order they arrived.
    const newest = (previewCandidates.get(row.target) ?? [])
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, input.previewLimit)
      .reverse();
    row.previews = newest.map((candidate) => candidate.line);
    // Only a preview the notice actually rendered counts as shown.
    for (const candidate of newest)
      if (candidate.whole) whole.push({ target: row.target, sequence: candidate.sequence });
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
    return row.previews.length ? [line, ...row.previews.map((it) => `  ${it}`)].join("\n") : line;
  });
}

/**
 * The sequences whose whole text a notice showed, per Agent and target. Volatile by design: a new
 * context clears them, because a preview the model no longer holds is not a shown message.
 */
export class PreviewSeen {
  readonly #byAgent = new Map<string, Map<string, Set<number>>>();

  has(agentId: string, target: string, sequence: number): boolean {
    return this.#byAgent.get(agentId)?.get(target)?.has(sequence) ?? false;
  }

  recorded(agentId: string, target: string): ReadonlySet<number> | undefined {
    return this.#byAgent.get(agentId)?.get(target);
  }

  record(agentId: string, shown: readonly PreviewedWhole[]): void {
    if (!shown.length) return;
    const byTarget = this.#byAgent.get(agentId) ?? new Map<string, Set<number>>();
    for (const entry of shown) {
      const seen = byTarget.get(entry.target) ?? new Set<number>();
      seen.add(entry.sequence);
      byTarget.set(entry.target, seen);
    }
    this.#byAgent.set(agentId, byTarget);
  }

  clear(agentId: string): void {
    this.#byAgent.delete(agentId);
  }

  /** `recorded` plus this Agent's previewed sequences for `target`, ascending, the newest
   * `limit` — what a send reports as `seenExactSeqs`. */
  mergeExact(
    agentId: string,
    target: string,
    recorded: readonly number[] | undefined,
    limit: number,
  ): readonly number[] | undefined {
    const previewed = this.recorded(agentId, target);
    if (!previewed?.size) return recorded;
    return [...new Set([...(recorded ?? []), ...previewed])]
      .sort((left, right) => left - right)
      .slice(-limit);
  }
}
