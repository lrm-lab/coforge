import { Button as AriaButton } from "react-aria-components";
import { ChevronRight } from "@untitledui/icons";

import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import {
  ActorAvatarStack,
  ActorAvatarStackMore,
  AVATAR_STACK_LIMIT,
} from "#src/features/avatars/actor-avatar-stack";
import { AVATAR_STACK_RING } from "#src/features/avatars/avatar-stack-ring";
import { AvatarAddButton } from "#src/components/base/avatar/base-components/avatar-add-button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { Skeleton } from "#src/components/ui/skeleton";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { useChannelMembers } from "./channel-members-query";
import { SettingsCard } from "./settings-panel-parts";

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
  const shown = entries.slice(0, AVATAR_STACK_LIMIT);
  const more = entries.length - shown.length;
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
      <div className="mt-3 flex items-center" aria-busy={members.isPending}>
        {members.isPending && (
          <div className="flex -space-x-1.5">
            {Array.from({ length: AVATAR_STACK_LIMIT }, (_, index) => (
              <Skeleton key={index} className="size-6 rounded-full" />
            ))}
          </div>
        )}
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
        {shown.length > 0 && (
          <ActorAvatarStack aria-label={m.channel_settings_members()}>
            {shown.map((entry) => (
              <Tooltip key={entry.key} title={entry.displayName}>
                <TooltipTrigger
                  className="inline-flex shrink-0 items-center justify-center rounded-full p-0 leading-none hover:z-10 focus-visible:z-10"
                  onPress={onOpenMembers}
                >
                  <ActorAvatar
                    presence
                    userId={entry.key.startsWith("user:") ? entry.id : undefined}
                    agentId={entry.key.startsWith("agent:") ? entry.id : undefined}
                    size="xs"
                    alt=""
                    src={entry.avatarUrl ?? undefined}
                    name={entry.displayName}
                    className={AVATAR_STACK_RING.outline}
                  />
                  <span className="sr-only">{entry.displayName}</span>
                </TooltipTrigger>
              </Tooltip>
            ))}
            {more > 0 && (
              <Tooltip title={m.channel_settings_members_more({ count: more })}>
                <TooltipTrigger
                  className="inline-flex shrink-0 items-center justify-center rounded-full p-0 leading-none hover:z-10 focus-visible:z-10"
                  onPress={onOpenMembers}
                >
                  <ActorAvatarStackMore more={more} />
                  <span className="sr-only">
                    {m.channel_settings_members_more({ count: more })}
                  </span>
                </TooltipTrigger>
              </Tooltip>
            )}
          </ActorAvatarStack>
        )}
        {canAdd && members.data && (
          <AvatarAddButton
            size="xs"
            className={cn("border-secondary text-avatar-add-fg", shown.length > 0 && "ms-2")}
            title={m.channel_settings_add_members()}
            onPress={onAddMembers}
          />
        )}
      </div>
    </SettingsCard>
  );
}
