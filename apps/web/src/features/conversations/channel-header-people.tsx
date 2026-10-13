import { Link } from "@tanstack/react-router";
import { Folder } from "@untitledui/icons";

import { Avatar } from "#src/components/base/avatar/avatar";
import { AvatarAddButton } from "#src/components/base/avatar/base-components/avatar-add-button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { Skeleton } from "#src/components/ui/skeleton";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { m } from "#src/paraglide/messages";
import { useChannelMembers } from "./channel-members-query";

/** Faces kept in the header before the rest collapse into "+N". The mockup shows four. */
export const CHANNEL_HEADER_FACE_LIMIT = 4;

export type ChannelHeaderFace = {
  key: string;
  displayName: string;
  avatarUrl: string | null;
};

/** The project named on a channel, as a folder chip beside the title. Absent when the channel
 * has no project. */
export function ChannelProjectChip({
  workspaceSlug,
  project,
}: {
  workspaceSlug: string;
  project: { name: string; slug: string };
}) {
  return (
    <Link
      to="/w/$workspaceSlug/projects/$projectSlug"
      params={{ workspaceSlug, projectSlug: project.slug }}
      aria-label={`${m.channel_settings_project()}: ${project.name}`}
      className="inline-flex h-7 min-w-0 max-w-40 shrink items-center gap-1.5 rounded-lg border border-secondary bg-primary px-2 text-sm font-medium text-secondary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
    >
      <Folder aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
      <span className="truncate">{project.name}</span>
    </Link>
  );
}

/** The overlapping member faces and the dashed invite button. Presentational, so the header and
 * a test can both supply the roster. */
export function ChannelHeaderFaces({
  entries,
  canAdd,
  onOpenMembers,
  onAddMembers,
}: {
  entries: readonly ChannelHeaderFace[];
  canAdd: boolean;
  onOpenMembers: () => void;
  onAddMembers: () => void;
}) {
  const shown = entries.slice(0, CHANNEL_HEADER_FACE_LIMIT);
  const more = entries.length - shown.length;
  if (shown.length === 0 && !canAdd) return null;
  return (
    <div className="flex shrink-0 items-center">
      {shown.length > 0 && (
        <div className="flex items-center -space-x-2" aria-label={m.channel_settings_members()}>
          {shown.map((entry) => (
            <Tooltip key={entry.key} title={entry.displayName}>
              <TooltipTrigger className="shrink-0 rounded-full" onPress={onOpenMembers}>
                <Avatar
                  size="xs"
                  alt=""
                  src={entry.avatarUrl ?? undefined}
                  initials={avatarInitial(entry.displayName)}
                  contentClassName={avatarToneClassName(entry.displayName)}
                  className="ring-2 ring-bg-primary"
                />
                <span className="sr-only">{entry.displayName}</span>
              </TooltipTrigger>
            </Tooltip>
          ))}
          {more > 0 && (
            <Tooltip title={m.channel_settings_members_more({ count: more })}>
              <TooltipTrigger className="shrink-0 rounded-full" onPress={onOpenMembers}>
                <Avatar
                  size="xs"
                  alt=""
                  initials={`+${more}`}
                  contentClassName="bg-brand-primary text-brand-secondary *:text-brand-secondary"
                  className="ring-2 ring-bg-primary"
                />
                <span className="sr-only">{m.channel_settings_members_more({ count: more })}</span>
              </TooltipTrigger>
            </Tooltip>
          )}
        </div>
      )}
      {canAdd && (
        <AvatarAddButton
          size="xs"
          className={shown.length > 0 ? "ml-2" : undefined}
          title={m.channel_settings_add_members()}
          onPress={onAddMembers}
        />
      )}
    </div>
  );
}

/** Loads the channel roster and draws the header faces. Shares the settings panel's query. */
export function ChannelHeaderMemberCluster({
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
  if (members.isPending) {
    return (
      <div
        aria-busy="true"
        aria-label={m.channel_members_loading()}
        className="flex shrink-0 -space-x-2"
      >
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="size-6 rounded-full" />
        ))}
      </div>
    );
  }
  if (!members.data) return null;
  const entries: ChannelHeaderFace[] = [
    ...members.data.humans.map((human) => ({
      key: `user:${human.id}`,
      displayName: human.displayName,
      avatarUrl: human.avatarUrl,
    })),
    ...members.data.agents.map((agent) => ({
      key: `agent:${agent.id}`,
      displayName: agent.displayName,
      avatarUrl: agent.avatarUrl,
    })),
  ];
  return (
    <ChannelHeaderFaces
      entries={entries}
      canAdd={canAdd}
      onOpenMembers={onOpenMembers}
      onAddMembers={onAddMembers}
    />
  );
}
