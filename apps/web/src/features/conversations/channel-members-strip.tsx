import { ChevronRight } from "@untitledui/icons";

import { Avatar } from "#src/components/base/avatar/avatar";
import { AvatarAddButton } from "#src/components/base/avatar/base-components/avatar-add-button";
import { Button } from "#src/components/base/buttons/button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { Skeleton } from "#src/components/ui/skeleton";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { m } from "#src/paraglide/messages";
import { useChannelMembers } from "./channel-members-query";

/** How many member avatars the strip shows before the "+N" tile. */
const MEMBER_STRIP_LIMIT = 14;

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
  const shown = entries.slice(0, MEMBER_STRIP_LIMIT);
  const more = entries.length - shown.length;
  return (
    <section className="py-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-md font-semibold text-primary">{m.channel_settings_members()}</h3>
        <Button
          color="link-gray"
          size="sm"
          iconTrailing={ChevronRight}
          className="min-w-0"
          onPress={onOpenMembers}
        >
          {members.data
            ? `${m.channel_settings_humans({ count: humans.length })} · ${m.channel_settings_agents({ count: agents.length })}`
            : m.channel_members_loading()}
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2" aria-busy={members.isPending}>
        {members.isPending &&
          Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="size-8 rounded-full" />
          ))}
        {members.isError && (
          <p role="alert" className="text-sm text-error-primary">
            {m.channel_members_load_error()}
          </p>
        )}
        {shown.map((entry) => (
          <Tooltip key={entry.key} title={entry.displayName}>
            <TooltipTrigger className="shrink-0 rounded-full" onPress={onOpenMembers}>
              <Avatar
                size="sm"
                alt=""
                src={entry.avatarUrl ?? undefined}
                initials={avatarInitial(entry.displayName)}
                contentClassName={avatarToneClassName(entry.displayName)}
              />
              <span className="sr-only">{entry.displayName}</span>
            </TooltipTrigger>
          </Tooltip>
        ))}
        {more > 0 && (
          <Tooltip title={m.channel_settings_members_more({ count: more })}>
            <TooltipTrigger className="shrink-0 rounded-full" onPress={onOpenMembers}>
              <Avatar size="sm" alt="" initials={`+${more}`} />
              <span className="sr-only">{m.channel_settings_members_more({ count: more })}</span>
            </TooltipTrigger>
          </Tooltip>
        )}
        {canAdd && members.data && (
          <AvatarAddButton
            size="sm"
            title={m.channel_settings_add_members()}
            onPress={onAddMembers}
          />
        )}
      </div>
    </section>
  );
}
