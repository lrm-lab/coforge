import { CheckCircle, SlashCircle01 } from "@untitledui/icons";

import { ActorName } from "#src/features/avatars/actor-name";
import type { ActionCardViewBase } from "#src/server/conversations/action-card-view.server";
import type { ActionCardActor } from "#src/server/conversations/action-card-view.server";
import { messageSlots } from "#src/lib/message-slots";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { AnsweredAtTooltip } from "./action-card-answered-at";
import { cardActor } from "./action-card-actor";

type ClosedCard = Pick<ActionCardViewBase, "state" | "committedBy" | "committedAt"> & {
  asked?: ActionCardActor;
};

/** Whether a cancelled card was cancelled by the person it asked: they ignored it, rather than its
 * sender withdrawing it. */
export function ignoredByAsked(view: ClosedCard) {
  return view.state === "cancelled" && !!view.asked && view.committedBy?.id === view.asked.id;
}

/**
 * How a closed card ended, said in words on one line, so anyone looking at someone else's card
 * tells at a glance whether it was answered, ignored, withdrawn or ran out (Frank, task #94: "看不出
 * 来已提交和未提交"). Answered behind a green check, the others behind a slash in gray; a person
 * other than the viewer is named by face and name. When it closed is the line's tooltip.
 */
export function CardOutcome({
  view,
  className = "px-2.5 pb-1",
}: {
  view: ClosedCard;
  /** Its place in the card: the questions card insets it; a handled choice's own padding does. */
  className?: string;
}) {
  const by = view.committedBy;
  const named = (message: (slots: { name: string }) => string, own: string) =>
    by && !by.isViewer
      ? messageSlots(message, { name: <ActorName actor={cardActor(by)} inline /> })
      : own;
  const answered = view.state === "executed";
  const ignored = ignoredByAsked(view);
  // The line names whoever answered or ignored it; a card withdrawn or run out names whoever
  // closed it in the tooltip instead (task #472).
  const tooltipBy = answered || ignored || !by || by.isViewer ? undefined : by;
  const words = answered
    ? named(m.action_card_answered_by, m.action_card_answered())
    : ignored
      ? named(m.action_card_ignored_by, m.action_card_ignored_short())
      : view.state === "expired"
        ? m.action_card_expired()
        : m.action_card_cancelled();
  const line = (
    <span
      data-card-outcome={answered ? "answered" : ignored ? "ignored" : view.state}
      className={answered ? "text-secondary" : "text-quaternary"}
    >
      <span className="inline-flex max-w-full items-center gap-1.5">
        {answered ? (
          <CheckCircle aria-hidden="true" className="size-4 shrink-0 text-fg-success-secondary" />
        ) : (
          <SlashCircle01 aria-hidden="true" className="size-4 shrink-0" />
        )}
        <span className="min-w-0 truncate">{words}</span>
      </span>
    </span>
  );
  return (
    <div className={cn("text-sm", className)}>
      {view.committedAt ? (
        <AnsweredAtTooltip at={view.committedAt} by={tooltipBy}>
          {line}
        </AnsweredAtTooltip>
      ) : (
        line
      )}
    </div>
  );
}
