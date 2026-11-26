import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
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
export type PreviewedWhole = {
  target: string;
  conversationId: string;
  sequence: number;
  scopeKey?: string;
};

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
