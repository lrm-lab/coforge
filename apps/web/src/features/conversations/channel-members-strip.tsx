import { Button as AriaButton } from "react-aria-components";
import { ChevronRight } from "@untitledui/icons";

import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { AvatarAddButton } from "#src/components/base/avatar/base-components/avatar-add-button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";
import { useChannelMembers } from "./channel-members-query";
import { SettingsCard } from "./settings-panel-parts";

const MEMBER_GRID_COLUMNS = 5;
const MEMBER_GRID_ROWS = 3;
const MEMBER_GRID_SLOTS = MEMBER_GRID_COLUMNS * MEMBER_GRID_ROWS;
const MEMBER_GRID_HIT_TARGET =
  "relative any-pointer-coarse:after:absolute any-pointer-coarse:after:top-1/2 any-pointer-coarse:after:left-1/2 any-pointer-coarse:after:size-full any-pointer-coarse:after:min-h-11 any-pointer-coarse:after:min-w-11 any-pointer-coarse:after:-translate-x-1/2 any-pointer-coarse:after:-translate-y-1/2";

export function sliceMembersGrid<T>(
  entries: readonly T[],
  hasAddSlot: boolean,
): { shown: readonly T[]; more: number } {
  const maxContentSlots = hasAddSlot ? MEMBER_GRID_SLOTS - 1 : MEMBER_GRID_SLOTS;
  if (entries.length <= maxContentSlots) {
    return { shown: entries, more: 0 };
  }
  const shownCount = maxContentSlots - 1;
  return {
    shown: entries.slice(0, shownCount),
    more: entries.length - shownCount,
  };
}

export function MembersStrip({
  channelId,
  canAdd,
  onOpenMembers,
  onAddMembers,
}: {
  channelId: string;
  canAdd: boolean;
  onOpenMembers: () => void;
  onAddMembers: () => void;
}) {
  const members = useChannelMembers(channelId);
  const humans = members.data?.humans ?? [];
  const agents = members.data?.agents ?? [];
  const entries = [
    ...humans.map((human) => ({ key: `user:${human.id}`, ...human })),
    ...agents.map((agent) => ({ key: `agent:${agent.id}`, ...agent })),
  ];
  const { shown, more } = sliceMembersGrid(entries, canAdd);
  const showAddButton = canAdd && Boolean(members.data);
  const showGrid = members.isPending || shown.length > 0 || showAddButton;
  return (
    <SettingsCard className="p-3.5">
      <h3>
        <AriaButton
          className="-m-1.5 flex w-[calc(100%+0.75rem)] cursor-pointer items-center justify-between gap-3 rounded-lg p-1.5 text-sm outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
          onPress={onOpenMembers}
        >
          <span className="font-semibold text-primary">{m.channel_settings_members()}</span>
          <span className="flex min-w-0 items-center gap-1 text-tertiary">
            <span className="truncate">
              {members.data
                ? `${m.channel_settings_humans({ count: humans.length })} · ${m.channel_settings_agents({ count: agents.length })}`
                : members.isError
                  ? ""
                  : m.channel_members_loading()}
            </span>
            <ChevronRight aria-hidden="true" className="size-4 shrink-0" />
          </span>
        </AriaButton>
      </h3>
      <div className="mt-3" aria-busy={members.isPending}>
        {members.isError && (
          <EmptyState
            size="row"
            role="alert"
            className="w-full px-0"
            title={m.empty_members_load_failed_title()}
            primaryAction={
              <RetryButton
                size="row"
                isRetrying={members.isRefetching}
                onPress={() => void members.refetch()}
              />
            }
          />
        )}
        {!members.isError && showGrid && (
          <div
            role="group"
            aria-label={m.channel_settings_members()}
            className="grid grid-cols-5 place-items-center gap-x-2 gap-y-3"
          >
            {members.isPending &&
              Array.from({ length: MEMBER_GRID_COLUMNS }, (_, index) => (
                <Skeleton key={index} className="size-[2.375rem] rounded-full" />
              ))}
            {shown.map((entry) => (
              <Tooltip key={entry.key} title={entry.displayName}>
                <TooltipTrigger
                  className={`inline-flex shrink-0 items-center justify-center rounded-full p-0 leading-none ${MEMBER_GRID_HIT_TARGET}`}
                  onPress={onOpenMembers}
                >
                  <ActorAvatar
                    presence
                    userId={entry.key.startsWith("user:") ? entry.id : undefined}
                    agentId={entry.key.startsWith("agent:") ? entry.id : undefined}
                    size="sm"
                    alt=""
                    src={entry.avatarUrl ?? undefined}
                    name={entry.displayName}
                  />
                  <span className="sr-only">{entry.displayName}</span>
                </TooltipTrigger>
              </Tooltip>
            ))}
            {more > 0 && (
              <Tooltip title={m.channel_settings_members_more({ count: more })}>
                <TooltipTrigger
                  className={`inline-flex shrink-0 items-center justify-center rounded-full p-0 leading-none ${MEMBER_GRID_HIT_TARGET}`}
                  onPress={onOpenMembers}
                >
                  <ActorAvatar
                    presence={false}
                    size="sm"
                    alt=""
                    initials={`+${more}`}
                    contentClassName="bg-avatar-more text-avatar-more-fg outline-none [&>span]:text-avatar-more-fg [&>span]:tabular-nums"
                  />
                  <span className="sr-only">
                    {m.channel_settings_members_more({ count: more })}
                  </span>
                </TooltipTrigger>
              </Tooltip>
            )}
            {showAddButton && (
              <AvatarAddButton
                size="sm"
                className={`size-[2.375rem] rounded-full border-secondary text-avatar-add-fg ${MEMBER_GRID_HIT_TARGET}`}
                title={m.channel_settings_add_members()}
                onPress={onAddMembers}
              />
            )}
          </div>
        )}
      </div>
    </SettingsCard>
  );
}
