import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { ActorAvatarStack } from "#src/features/avatars/actor-avatar-stack";
import { AVATAR_STACK_RING } from "#src/features/avatars/avatar-stack-ring";
import { AvatarAddButton } from "#src/components/base/avatar/base-components/avatar-add-button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { Skeleton } from "#src/components/ui/skeleton";
import { AgentHoverCard } from "#src/features/agents/agent-hover-card";
import {
  useOpenAgentProfile,
  type OpenAgentProfile,
} from "#src/features/agents/profile-panel/open-agent-profile";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { useChannelMembers } from "./channel-members-query";
import { PersonHoverCard } from "./person-hover-card";

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
        <ActorAvatarStack className="hidden md:flex" aria-label={m.channel_settings_members()}>
          {shown.map((entry) => {
            const isAgent = Boolean(entry.agentId) || entry.kind === "agent";
            const agentId = isAgent
              ? (entry.agentId ?? entry.key.replace(/^agent:/, ""))
              : undefined;
            const userId = isAgent
              ? undefined
              : (entry.userId ??
                (entry.key.startsWith("user:") ? entry.key.replace(/^user:/, "") : undefined));
            const avatarNode = (
              <>
                <ActorAvatar
                  presence
                  agentId={agentId}
                  userId={userId}
                  size="sm"
                  alt=""
                  src={entry.avatarUrl ?? undefined}
                  name={entry.displayName}
                  className={cn("avatar-header", AVATAR_STACK_RING.regular)}
                />
                <span className="sr-only">{entry.displayName}</span>
              </>
            );

            if (agentId) {
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
                <ActorAvatar
                  presence={false}
                  size="sm"
                  alt=""
                  initials={`+${more}`}
                  contentClassName={cn(
                    "bg-avatar-more text-avatar-more-fg outline-none [&>span]:text-avatar-more-fg [&>span]:tabular-nums",
                    more > 99 && "px-1.5",
                  )}
                  className={cn(
                    "avatar-header",
                    more > 99 && "[&&]:w-auto [&&]:min-w-8",
                    AVATAR_STACK_RING.regular,
                  )}
                />
                <span className="sr-only">{m.channel_settings_members_more({ count: more })}</span>
              </TooltipTrigger>
            </Tooltip>
          )}
        </ActorAvatarStack>
      )}
      {canAdd && (
        <AvatarAddButton
          size="sm"
          className={cn("border-secondary text-avatar-add-fg", shown.length > 0 && "md:ml-2")}
          title={m.channel_settings_add_members()}
          onPress={onAddMembers}
        />
      )}
    </div>
  );
}

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
        className="hidden shrink-0 -space-x-1.5 md:flex"
      >
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="size-8 rounded-full" />
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
