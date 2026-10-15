import { Link } from "@tanstack/react-router";
import { Folder } from "@untitledui/icons";
import { Heading } from "react-aria-components";

import { Avatar } from "#src/components/base/avatar/avatar";
import { AvatarAddButton } from "#src/components/base/avatar/base-components/avatar-add-button";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { HoverPopover, useClosePreview } from "#src/components/ui/hover-popover";
import { Skeleton } from "#src/components/ui/skeleton";
import { StatusDot } from "#src/components/ui/status-dot";
import { AgentHoverCard } from "#src/features/agents/agent-hover-card";
import {
  useOpenAgentProfile,
  type OpenAgentProfile,
  type OpenPersonProfile,
} from "#src/features/agents/profile-panel/open-agent-profile";
import { useOpenDirectConversation } from "#src/features/conversations/open-direct-conversation";
import { MemberAvatar } from "#src/features/workspaces/member-avatar";
import { useMemberOnline } from "#src/features/workspaces/member-presence";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { m } from "#src/paraglide/messages";
import { useChannelMembers } from "./channel-members-query";

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

/** Owner and admin are Workspace roles; a channel admin is one by this channel's own role. */
function roleLabel(member: { serverRole?: string | null; channelRole?: string }) {
  if (member.serverRole === "owner") return m.channel_members_role_owner();
  if (member.serverRole === "admin") return m.channel_members_role_admin();
  if (member.channelRole === "admin") return m.channel_members_role_channel_admin();
  return m.channel_members_role_member();
}

/** The profile card shown on hover for a human member. */
function MemberProfileCard({
  userId,
  name,
  src,
  description,
  serverRole,
  channelRole,
  onOpenDirect,
  onOpenProfile,
}: {
  userId?: string;
  name: string;
  src?: string | null;
  description?: string | null;
  serverRole?: string | null;
  channelRole?: string;
  onOpenDirect?: (peer: { userId: string }) => void;
  onOpenProfile?: OpenPersonProfile;
}) {
  const online = userId ? useMemberOnline(userId) : undefined;
  const closePreview = useClosePreview();

  const roleText =
    serverRole || channelRole
      ? roleLabel({ serverRole, channelRole: channelRole ?? "member" })
      : null;

  return (
    <>
      <div className="flex items-start gap-3 p-3">
        {userId ? (
          <MemberAvatar size="md" userId={userId} name={name} src={src ?? null} />
        ) : (
          <Avatar
            size="md"
            alt=""
            src={src ?? undefined}
            initials={avatarInitial(name)}
            contentClassName={avatarToneClassName(name)}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <Heading slot="title" className="truncate text-sm font-semibold text-primary">
              {name}
            </Heading>
            {online !== undefined && (
              <span className="flex min-w-0 items-center gap-1 text-xs text-tertiary">
                <StatusDot tone={online ? "online" : "offline"} className="size-1.5 shrink-0" />
                <span className="truncate">{online ? m.member_online() : m.member_offline()}</span>
              </span>
            )}
          </div>
          {roleText && (
            <div className="mt-1">
              <Badge size="sm" color="gray">
                {roleText}
              </Badge>
            </div>
          )}
        </div>
      </div>
      {description && (
        <p className="border-t border-secondary px-3 py-2 text-xs text-secondary break-words line-clamp-3">
          {description}
        </p>
      )}
      {userId && (onOpenDirect || onOpenProfile) && (
        <div className="border-t border-secondary px-3 py-2 flex justify-end gap-2">
          {onOpenProfile && (
            <Button
              size="sm"
              color="secondary"
              onPress={() => {
                closePreview();
                onOpenProfile(userId);
              }}
            >
              {m.member_person_view_profile()}
            </Button>
          )}
          {onOpenDirect && (
            <Button
              size="sm"
              color="secondary"
              onPress={() => {
                closePreview();
                void onOpenDirect({ userId });
              }}
            >
              {m.member_private_chat()}
            </Button>
          )}
        </div>
      )}
    </>
  );
}

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
  onOpenPersonProfile,
  onOpenDirect,
}: {
  entries: readonly ChannelHeaderFace[];
  canAdd: boolean;
  onOpenMembers: () => void;
  onAddMembers: () => void;
  onOpenAgentProfile?: OpenAgentProfile;
  onOpenPersonProfile?: OpenPersonProfile;
  onOpenDirect?: (peer: { userId: string }) => void;
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
                <Avatar
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
              <HoverPopover
                key={entry.key}
                label={entry.displayName}
                trigger={avatarNode}
                triggerClassName="inline-flex shrink-0 items-center justify-center rounded-full p-0 leading-none"
                className="w-70"
                onPress={onOpenMembers}
              >
                <MemberProfileCard
                  userId={userId}
                  name={entry.displayName}
                  src={entry.avatarUrl}
                  description={entry.description}
                  serverRole={entry.serverRole}
                  channelRole={entry.channelRole}
                  onOpenDirect={onOpenDirect}
                  onOpenProfile={onOpenPersonProfile}
                />
              </HoverPopover>
            );
          })}
          {more > 0 && (
            <Tooltip title={m.channel_settings_members_more({ count: more })}>
              <TooltipTrigger
                className="inline-flex shrink-0 items-center justify-center rounded-full p-0 leading-none"
                onPress={onOpenMembers}
              >
                <Avatar
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
  const { openAgentProfile, openPersonProfile } = useOpenAgentProfile();
  const openDirect = useOpenDirectConversation();

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
      onOpenPersonProfile={openPersonProfile}
      onOpenDirect={openDirect}
    />
  );
}
