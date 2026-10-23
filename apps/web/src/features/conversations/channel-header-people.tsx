import { Link } from "@tanstack/react-router";
import { Folder } from "@untitledui/icons";

import { IdentityAvatar } from "#src/features/agents/avatar-sticker";
import { AvatarAddButton } from "#src/components/base/avatar/base-components/avatar-add-button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { Skeleton } from "#src/components/ui/skeleton";
import { AgentHoverCard } from "#src/features/agents/agent-hover-card";
import {
  useOpenAgentProfile,
  type OpenAgentProfile,
} from "#src/features/agents/profile-panel/open-agent-profile";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { m } from "#src/paraglide/messages";
import { useChannelMembers } from "./channel-members-query";
import { PersonHoverCard } from "./person-hover-card";

/** Faces kept in the header before the rest collapse into "+N". The mockup shows four. */
export const CHANNEL_HEADER_FACE_LIMIT = 4;

export type ChannelHeaderFace = {
  key: string;
  displayName: string;
  avatarUrl: string | null;
  kind?: "human" | "agent";
  userId?: string;
  agentId?: string;
  name?: string;
  description?: string | null;
  serverRole?: string | null;
  channelRole?: string;
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
      className="inline-flex h-7 min-w-8 max-w-40 shrink-[999] items-center gap-1.5 rounded-lg border border-secondary bg-primary px-2 text-sm font-medium text-secondary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
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
  onOpenAgentProfile,
}: {
  entries: readonly ChannelHeaderFace[];
  canAdd: boolean;
  onOpenMembers: () => void;
  onAddMembers: () => void;
  onOpenAgentProfile?: OpenAgentProfile;
}) {
  const shown = entries.slice(0, CHANNEL_HEADER_FACE_LIMIT);
  const more = entries.length - shown.length;
  if (shown.length === 0 && !canAdd) return null;
  return (
    <div className="flex shrink-0 items-center">
      {shown.length > 0 && (
        <div
          className="hidden items-center -space-x-1 md:flex"
          aria-label={m.channel_settings_members()}
        >
          {shown.map((entry) => {
            const avatarNode = (
              <>
                <IdentityAvatar
                  size="xs"
                  alt=""
                  src={entry.avatarUrl ?? undefined}
                  initials={avatarInitial(entry.displayName)}
                  contentClassName={avatarToneClassName(entry.displayName)}
                  className="ring-[1.5px] ring-bg-primary"
                />
                <span className="sr-only">{entry.displayName}</span>
              </>
            );

            if (entry.agentId || entry.kind === "agent") {
              const agentId = entry.agentId ?? entry.key.replace(/^agent:/, "");
              return (
                <AgentHoverCard
                  key={entry.key}
                  agentId={agentId}
                  name={entry.displayName}
                  handle={entry.name}
                  src={entry.avatarUrl}
                  trigger={avatarNode}
                  triggerClassName="inline-flex shrink-0 items-center justify-center rounded-full p-0 leading-none"
                  onOpenProfile={onOpenAgentProfile}
                />
              );
            }

            const userId =
              entry.userId ??
              (entry.key.startsWith("user:") ? entry.key.replace(/^user:/, "") : undefined);

            return (
              <PersonHoverCard
                key={entry.key}
                label={entry.displayName}
                trigger={avatarNode}
                triggerClassName="inline-flex shrink-0 items-center justify-center rounded-full p-0 leading-none"
                onPress={onOpenMembers}
                userId={userId}
                name={entry.displayName}
                loaded={{
                  src: entry.avatarUrl,
                  description: entry.description,
                  serverRole: entry.serverRole,
                  channelRole: entry.channelRole,
                }}
              />
            );
          })}
          {more > 0 && (
            <Tooltip title={m.channel_settings_members_more({ count: more })}>
              <TooltipTrigger
                className="inline-flex shrink-0 items-center justify-center rounded-full p-0 leading-none"
                onPress={onOpenMembers}
              >
                <IdentityAvatar
                  size="xs"
                  alt=""
                  initials={`+${more}`}
                  contentClassName="bg-brand-primary text-brand-secondary *:text-brand-secondary"
                  className="ring-[1.5px] ring-bg-primary"
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
          className={shown.length > 0 ? "md:ml-2" : undefined}
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
  const { openAgentProfile } = useOpenAgentProfile();

  if (members.isPending) {
    return (
      <div
        aria-busy="true"
        aria-label={m.channel_members_loading()}
        className="hidden shrink-0 -space-x-1 md:flex"
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
      kind: "human" as const,
      key: `user:${human.id}`,
      userId: human.id,
      displayName: human.displayName,
      description: human.description,
      avatarUrl: human.avatarUrl,
      serverRole: human.serverRole,
      channelRole: human.channelRole,
    })),
    ...members.data.agents.map((agent) => ({
      kind: "agent" as const,
      key: `agent:${agent.id}`,
      agentId: agent.id,
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      avatarUrl: agent.avatarUrl,
      serverRole: agent.serverRole,
      channelRole: agent.channelRole,
    })),
  ];
  return (
    <ChannelHeaderFaces
      entries={entries}
      canAdd={canAdd}
      onOpenMembers={onOpenMembers}
      onAddMembers={onAddMembers}
      onOpenAgentProfile={openAgentProfile}
    />
  );
}
