import { Link } from "@tanstack/react-router";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";

import { RelativeTime } from "#src/components/ui/relative-time";
import { choiceNumber } from "#src/features/conversations/choice-number";
import { ChannelTitle } from "#src/features/conversations/channel-name";
import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import type { WaitingChoiceCard } from "#src/server/conversations/waiting-choice-cards.server";
import { followInternalLinkClick } from "#src/features/conversations/internal-app-href";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ACTIVITY_ROW_ITEM_CLASS, ACTIVITY_ROW_LINK_CLASS } from "./activity-inbox-row";
import { activityChatLink, waitingChoiceTarget } from "./activity-open-target";

/**
 * A choice card waiting on the viewer, laid out as an Activity row: the asking Agent's face, the
 * question, then where it was asked, by whom, and the numbered options. Opening it opens the
 * conversation at the card, to be answered there; a modified click opens it in Chat. The open
 * conversation's own row below marks it as open, so this one does not.
 */
export function WaitingChoiceRow({
  card,
  onOpen,
}: {
  card: WaitingChoiceCard;
  onOpen: (target: HostedConversationTarget) => void;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const target = waitingChoiceTarget(card);
  // Where it was asked: its channel, or a Task's, as "#channel · Task #N"; a DM goes unnamed.
  const channel = card.task?.channel ?? card.channel;
  // A private channel with its lock, as everywhere a channel is named (task #375).
  const taskLabel = card.task && m.activity_inbox_waiting_task({ number: card.task.number });
  const place =
    channel || taskLabel ? (
      <>
        {channel && <ChannelTitle {...channel} lockClassName="size-3.5" />}
        {channel && taskLabel && " · "}
        {taskLabel}
      </>
    ) : null;
  const options = card.options
    .map((option, index) => `${choiceNumber(index)}. ${option.label}`)
    .join(" · ");
  return (
    <li className={ACTIVITY_ROW_ITEM_CLASS}>
      <Link
        {...activityChatLink(workspaceSlug, target)}
        onClick={(event) => {
          if (!followInternalLinkClick(event)) return;
          event.preventDefault();
          onOpen(target);
        }}
        className={cn(ACTIVITY_ROW_LINK_CLASS, "hover:bg-primary_hover")}
      >
        <ActorAvatar
          size="sm"
          presence={false}
          agentId={card.preparedBy.agentId}
          name={card.preparedBy.name}
          src={card.preparedBy.avatarUrl}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-md font-semibold text-primary">
              {card.prompt}
            </span>
            <RelativeTime
              value={card.createdAt}
              plain
              className="ml-auto shrink-0 pl-2 font-mono text-xs text-quaternary tabular-nums"
            />
          </span>
          <span className="truncate text-sm text-tertiary">
            {place && <>{place} · </>}
            <span className="font-semibold text-secondary">{card.preparedBy.name}: </span>
            {options}
          </span>
        </span>
      </Link>
    </li>
  );
}
