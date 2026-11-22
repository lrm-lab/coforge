import { memo, type Ref } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link, useRouter } from "@tanstack/react-router";
import { XClose } from "@untitledui/icons";
import { Link as AriaLink } from "react-aria-components";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";

import { Button } from "#src/components/base/buttons/button";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { RelativeTime } from "#src/components/ui/relative-time";
import { useAppToast } from "#src/components/ui/toast";
import { cancelActionCard } from "#src/features/conversations/action-cards.functions";
import { choiceNumber } from "#src/features/conversations/choice-number";
import { ChannelPlace } from "#src/features/conversations/channel-name";
import { DeclineQuestion } from "#src/features/conversations/question-card-decline";
import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import type { WaitingChoiceCard } from "#src/server/conversations/waiting-choice-cards.server";
import { followInternalLinkClick } from "#src/features/conversations/internal-app-href";
import { cn } from "#src/lib/utils";
import { isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { ACTIVITY_ROW_ITEM_CLASS, ACTIVITY_ROW_LINK_CLASS } from "./activity-inbox-row";
import { activityChatLink, waitingChoiceTarget } from "./activity-open-target";
import { waitingRowKey } from "./use-activity-list-keyboard";

export const WaitingChoiceRow = memo(function WaitingChoiceRow({
  card,
  tabStop,
  onOpen,
  onDeclined,
  ref,
}: {
  card: WaitingChoiceCard;
  tabStop: boolean;
  onOpen: (target: HostedConversationTarget) => void;
  onDeclined: () => void;
  ref?: Ref<HTMLLIElement>;
}) {
  const router = useRouter();
  const toast = useAppToast();
  const cancel = useServerFn(cancelActionCard);
  const workspaceSlug = useWorkspaceSlug();
  const target = waitingChoiceTarget(card);
  const link = activityChatLink(workspaceSlug, target);
  const href = router.buildLocation(link).publicHref;
  const channel = card.task?.channel ?? card.channel;
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

  async function decline() {
    try {
      await cancel({ data: { messageId: card.messageId } });
    } catch (cause) {
      if (isAppErrorCode(cause, "CONFLICT")) return onDeclined();
      throw cause;
    }
    onDeclined();
  }

  return (
    <li
      ref={ref}
      data-activity-row={waitingRowKey(card.messageId)}
      className={cn(ACTIVITY_ROW_ITEM_CLASS, "select-none [-webkit-touch-callout:none]")}
    >
      <Dropdown.Root trigger="contextMenu">
        <AriaLink
          href={href}
          render={(props) =>
            "href" in props ? (
              <Link
                {...props}
                {...link}
                tabIndex={tabStop ? 0 : -1}
                onClick={(event) => {
                  if (followInternalLinkClick(event)) {
                    event.preventDefault();
                    onOpen(target);
                  }
                  props.onClick?.(event);
                }}
              />
            ) : (
              <span {...props} />
            )
          }
          className={cn(
            ACTIVITY_ROW_LINK_CLASS,
            "group-hover:bg-primary_hover focus-visible:bg-primary_hover",
          )}
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
                className="ml-auto shrink-0 pl-2 text-xs text-quaternary tabular-nums transition-opacity group-hover:opacity-0 not-any-pointer-coarse:group-focus-within:opacity-0"
              />
            </span>
            <span className="truncate text-sm text-tertiary">
              {place && <>{place} · </>}
              <span className="font-semibold text-secondary">{card.preparedBy.name}: </span>
              {options}
            </span>
          </span>
        </AriaLink>
        <Dropdown.Popover placement="bottom start">
          <Dropdown.Menu
            aria-label={m.activity_inbox_menu_label()}
            onAction={(key) => {
              if (key === "decline") {
                void decline().catch(() => toast.error(m.question_card_send_failed()));
              }
            }}
          >
            <Dropdown.Item
              id="decline"
              icon={XClose}
              label={m.question_card_decline()}
              selectionIndicator="none"
            />
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      <DeclineQuestion
        asker={card.preparedBy.name}
        questions={card.questions?.length ?? 1}
        placement="bottom end"
        onDecline={decline}
      >
        <Button
          data-decline=""
          size="sm"
          color="link-gray"
          aria-label={m.action_card_ignore_row({ prompt: card.prompt })}
          className="absolute top-1/2 right-[calc(var(--page-gutter)-0.25rem)] -translate-y-1/2 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 any-pointer-coarse:hidden"
        >
          {m.question_card_decline()}
        </Button>
      </DeclineQuestion>
    </li>
  );
});
