import { Button as AriaButton } from "react-aria-components";
import { ChevronRight } from "@untitledui/icons";

import { IdentityAvatar } from "#src/features/agents/avatar-sticker";
import { AvatarAddButton } from "#src/components/base/avatar/base-components/avatar-add-button";
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
      {/* One full-width row opens the roster: the section's name, then its counts. */}
      <h3>
        <AriaButton
          className="-mx-2 flex w-[calc(100%+1rem)] cursor-pointer items-center justify-between gap-3 rounded-lg bg-secondary px-2 py-1.5 text-sm outline-focus-ring hover:bg-secondary_hover focus-visible:outline-2"
          onPress={onOpenMembers}
        >
          <span className="font-semibold text-primary">{m.channel_settings_members()}</span>
          <span className="flex min-w-0 items-center gap-1 text-tertiary">
            <span className="truncate">
              {members.data
                ? `${m.channel_settings_humans({ count: humans.length })} · ${m.channel_settings_agents({ count: agents.length })}`
                : m.channel_members_loading()}
            </span>
            <ChevronRight aria-hidden="true" className="size-4 shrink-0" />
          </span>
        </AriaButton>
      </h3>
      <div className="mt-3 flex flex-wrap items-center gap-2" aria-busy={members.isPending}>
        {members.isPending &&
          Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="size-[2.375rem] rounded-full" />
          ))}
        {members.isError && (
          <p role="alert" className="text-sm text-error-primary">
            {m.channel_members_load_error()}
          </p>
        )}
        {shown.map((entry) => (
          <Tooltip key={entry.key} title={entry.displayName}>
            <TooltipTrigger className="shrink-0 rounded-full" onPress={onOpenMembers}>
              <IdentityAvatar
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
              <IdentityAvatar size="sm" alt="" initials={`+${more}`} />
              <span className="sr-only">{m.channel_settings_members_more({ count: more })}</span>
            </TooltipTrigger>
          </Tooltip>
        )}
        {canAdd && members.data && (
          <AvatarAddButton
            size="sm"
            // The member avatars' 38 × 38 circle (styles.css).
            className="size-[2.375rem] rounded-full"
            title={m.channel_settings_add_members()}
            onPress={onAddMembers}
          />
        )}
      </div>
    </section>
  );
}
