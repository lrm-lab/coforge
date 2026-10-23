import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Heading } from "react-aria-components";

import { Badge } from "#src/components/base/badges/badges";
import { HoverPopover } from "#src/components/ui/hover-popover";
import { Skeleton } from "#src/components/ui/skeleton";
import { StatusDot } from "#src/components/ui/status-dot";
import { memberPersonQuery } from "#src/features/agents/member-directory-queries";
import { IdentityAvatar } from "#src/features/agents/avatar-sticker";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { MemberAvatar } from "#src/features/workspaces/member-avatar";
import { useMemberOnline } from "#src/features/workspaces/member-presence";
import { isAppErrorCode } from "#src/lib/app-error";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { m } from "#src/paraglide/messages";

/** A card's read may be a few minutes old; re-hovering a person does not re-read them. */
const PERSON_CARD_STALE_MS = 5 * 60_000;
/** Transient failures are retried a couple of times; a person who is gone or hidden is not. */
const PERSON_CARD_RETRIES = 2;

/** What a card shows of a member beyond their name. */
export type PersonCardFields = {
  src?: string | null;
  description?: string | null;
  serverRole?: string | null;
  channelRole?: string;
};

/**
 * A member's face (an avatar in a roster, a mention chip in a message) that peeks at their card on
 * hover, focus or long press and runs `onPress` when pressed. Pass `loaded` when the caller
 * already holds the member's fields (a roster); without it the card reads the member by `userId`
 * when it opens, which the profile panel then reuses.
 */
export function PersonHoverCard({
  label,
  trigger,
  triggerClassName,
  inline,
  onPress,
  userId,
  name,
  loaded,
}: {
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  /** The trigger is inline text (a mention chip) rather than an avatar button. */
  inline?: boolean;
  onPress?: () => void;
  userId?: string;
  name: string;
  loaded?: PersonCardFields;
}) {
  return (
    <HoverPopover
      label={label}
      trigger={trigger}
      triggerClassName={triggerClassName}
      inline={inline}
      className="w-70"
      onPress={onPress}
    >
      {loaded || !userId ? (
        <MemberProfileCard userId={userId} name={name} {...loaded} />
      ) : (
        <FetchedMemberCard userId={userId} name={name} />
      )}
    </HoverPopover>
  );
}

/** The card's content when only the id is known. A popover mounts its children only while open,
 * so the read runs on a peek, never per face. */
function FetchedMemberCard({ userId, name }: { userId: string; name: string }) {
  const workspaceId = useCurrentWorkspaceId();
  const person = useQuery({
    ...memberPersonQuery(workspaceId ?? "", userId),
    enabled: workspaceId !== undefined,
    staleTime: PERSON_CARD_STALE_MS,
    retry: (failures, error) =>
      failures < PERSON_CARD_RETRIES &&
      !isAppErrorCode(error, "NOT_FOUND") &&
      !isAppErrorCode(error, "ACCESS_DENIED"),
  });
  const profile = person.data;
  return (
    <>
      <MemberProfileCard
        userId={userId}
        name={profile?.displayName ?? name}
        src={profile?.avatarUrl}
        description={profile?.description}
        serverRole={profile?.role}
      />
      {person.isPending && (
        <div className="border-t border-secondary px-3 py-2">
          <Skeleton className="h-3 w-40" />
        </div>
      )}
      {person.isError && (
        <p className="border-t border-secondary px-3 py-2 text-xs text-tertiary">
          {m.agent_card_unavailable()}
        </p>
      )}
    </>
  );
}

/** Owner and admin are Workspace roles; a channel admin is one by this channel's own role. */
function roleLabel(member: { serverRole?: string | null; channelRole?: string }) {
  if (member.serverRole === "owner") return m.channel_members_role_owner();
  if (member.serverRole === "admin") return m.channel_members_role_admin();
  if (member.channelRole === "admin") return m.channel_members_role_channel_admin();
  return m.channel_members_role_member();
}

/**
 * The profile card shown on hover for a human member. Deliberately no actions on it (the boss's
 * ruling, task #210): the hover is for a quick look at a face.
 */
function MemberProfileCard({
  userId,
  name,
  src,
  description,
  serverRole,
  channelRole,
}: PersonCardFields & {
  userId?: string;
  name: string;
}) {
  const online = userId ? useMemberOnline(userId) : undefined;

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
          <IdentityAvatar
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
    </>
  );
}
