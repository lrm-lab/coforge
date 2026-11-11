import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";

import { Button } from "#src/components/base/buttons/button";
import { RelativeTime } from "#src/components/ui/relative-time";
import { cancelActionCard } from "#src/features/conversations/action-cards.functions";
import { focusIgnore } from "#src/features/conversations/action-card-ignored";
import { useUndoableIgnore } from "#src/features/conversations/use-undoable-ignore";
import { choiceNumber } from "#src/features/conversations/choice-number";
import { ChannelPlace } from "#src/features/conversations/channel-name";
import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import type { WaitingChoiceCard } from "#src/server/conversations/waiting-choice-cards.server";
import { followInternalLinkClick } from "#src/features/conversations/internal-app-href";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ACTIVITY_ROW_ITEM_CLASS, ACTIVITY_ROW_LINK_CLASS } from "./activity-inbox-row";
import { activityChatLink, waitingChoiceTarget } from "./activity-open-target";
import { waitingRowKey } from "./use-activity-list-keyboard";

/**
 * A choice card waiting on the viewer, laid out as an Activity row: the asking Agent's face, the
 * question, then where it was asked, by whom, and the numbered options. Opening it opens the
 * conversation at the card, to be answered there; a modified click opens it in Chat. The open
 * conversation's own row below marks it as open, so this one does not.
 */
export function WaitingChoiceRow({
  card,
  tabStop,
  onOpen,
  onIgnored,
}: {
  card: WaitingChoiceCard;
  /** The list's one tab stop: the keyboard's selected row (`useActivityListKeyboard`). */
  tabStop: boolean;
  onOpen: (target: HostedConversationTarget) => void;
  /** The ignore went through, so the card no longer waits on the viewer: the list reads again. */
  onIgnored: () => void;
}) {
  const cancel = useServerFn(cancelActionCard);
  const rowRef = useRef<HTMLLIElement>(null);
  // The timed cancel failed: the row is back, and says so where its time was until the next try.
  const [failed, setFailed] = useState(false);
  const { ignored, ignore, undo } = useUndoableIgnore(async ({ keepalive }) => {
    try {
      await cancel({
        data: { messageId: card.messageId },
        // Sent as the page goes away, the request must outlive it.
        fetch: keepalive ? (input, init) => fetch(input, { ...init, keepalive: true }) : undefined,
      });
    } catch (cause) {
      if (!keepalive) setFailed(true);
      throw cause;
    }
    onIgnored();
  });
  const wasIgnored = useRef(false);
  // Focus follows the swap: to Undo once collapsed, back to Ignore once undone (or, if the cancel
  // fails, once the row is back).
  useEffect(() => {
    if (ignored) focusIgnore(rowRef.current, "undo");
    else if (wasIgnored.current) focusIgnore(rowRef.current, "ignore");
    wasIgnored.current = ignored;
  }, [ignored]);
  const workspaceSlug = useWorkspaceSlug();
  const target = waitingChoiceTarget(card);
  // Where it was asked: its channel, or a Task's, as its group avatar and name, then "· Task #N"
  // (task #55); a DM goes unnamed.
  const channel = card.task?.channel ?? card.channel;
  // A private channel with its lock, as everywhere a channel is named (task #375).
  const taskLabel = card.task && m.activity_inbox_waiting_task({ number: card.task.number });
  const place =
    channel || taskLabel ? (
      <>
        {channel && <ChannelPlace {...channel} />}
        {channel && taskLabel && " · "}
        {taskLabel}
      </>
    ) : null;
  const options = card.options
    .map((option, index) => `${choiceNumber(index)}. ${option.label}`)
    .join(" · ");
  return (
    <li
      ref={rowRef}
      data-activity-row={waitingRowKey(card.messageId)}
      className={ACTIVITY_ROW_ITEM_CLASS}
    >
      <Link
        {...activityChatLink(workspaceSlug, target)}
        tabIndex={tabStop ? 0 : -1}
        onClick={(event) => {
          if (!followInternalLinkClick(event)) return;
          event.preventDefault();
          onOpen(target);
        }}
        // The row's own hover, kept while the pointer is on its Ignore button (a sibling).
        className={cn(
          ACTIVITY_ROW_LINK_CLASS,
          "group-hover:bg-primary_hover focus-visible:bg-primary_hover",
        )}
      >
        <ActorAvatar
          className={cn(ignored && "opacity-50")}
          size="sm"
          presence={false}
          agentId={card.preparedBy.agentId}
          name={card.preparedBy.name}
          src={card.preparedBy.avatarUrl}
        />
        <span className={cn("flex min-w-0 flex-1 flex-col", ignored && "opacity-50")}>
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-md font-semibold text-primary">
              {card.prompt}
            </span>
            {failed && !ignored ? (
              <span className="ml-auto shrink-0 pl-2 text-xs text-error-primary transition-opacity group-hover:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-0">
                {m.action_card_ignore_failed()}
              </span>
            ) : (
              <RelativeTime
                value={card.createdAt}
                plain
                // Gives way to the Ignore button wherever it shows (hover, focus), and to "Ignored · Undo".
                className={cn(
                  "ml-auto shrink-0 pl-2 text-xs text-quaternary tabular-nums transition-opacity group-hover:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-0",
                  ignored && "invisible",
                )}
              />
            )}
          </span>
          <span className="truncate text-sm text-tertiary">
            {place && <>{place} · </>}
            <span className="font-semibold text-secondary">{card.preparedBy.name}: </span>
            {options}
          </span>
        </span>
      </Link>
      <Button
        data-ignore=""
        size="sm"
        color="link-gray"
        aria-label={m.action_card_ignore_row({ prompt: card.prompt })}
        onPress={() => {
          setFailed(false);
          ignore();
        }}
        className={cn(
          "absolute top-1/2 right-[calc(var(--page-gutter)-0.25rem)] -translate-y-1/2 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:hidden",
          ignored && "hidden",
        )}
      >
        {m.action_card_ignore()}
      </Button>
      {ignored && (
        <span className="absolute top-1/2 right-[calc(var(--page-gutter)-0.25rem)] flex -translate-y-1/2 items-center gap-1.5 text-sm text-tertiary">
          {m.action_card_ignored_short()} ·
          <Button data-ignore-undo="" size="sm" color="link-gray" onPress={undo}>
            {m.action_card_undo()}
          </Button>
        </span>
      )}
      {/* Read out as it changes: ignored (with its undo window), or the cancel that failed. */}
      <span role="status" className="sr-only">
        {ignored ? m.action_card_ignored_status() : failed ? m.action_card_ignore_failed() : ""}
      </span>
    </li>
  );
}
