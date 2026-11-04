import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { useLiveAgentDisplay } from "#src/features/agents/workspace-agents-realtime";
import { useMemberOnline } from "#src/features/workspaces/member-presence";
import { IdentityAvatar, type IdentityAvatarProps } from "./identity-avatar";

type ActorAvatarProps = Omit<IdentityAvatarProps, "status" | "badge"> & {
  /**
   * Whether this avatar carries the member's status dot (task #510, Frank 11-04): yes where the
   * page shows people as the ones around (members, DMs, pickers, hover cards, profiles, a
   * channel's faces, a message's sender); no where the face only says who did something ("seen
   * by", a Task's owner, history, reports). Required, so no page picks by accident. A person's
   * dot needs `userId`, an Agent's `agentId`.
   */
  presence: boolean;
  /** The Agent this face is, for its live status dot. */
  agentId?: string;
};

/**
 * The one avatar for anyone a page shows by face, a person or an Agent (task #510). A person's
 * online dot comes from Workspace presence, an Agent's from its live display; `IdentityAvatar`
 * is what this draws with, and nothing outside `features/avatars` uses it directly
 * (`coforge/one-avatar`).
 */
export function ActorAvatar({ presence, agentId, ...props }: ActorAvatarProps) {
  if (agentId && presence) return <AgentWithPresence {...props} agentId={agentId} />;
  // An Agent's face without its dot is still its own picture, or its mascot until that is known.
  if (agentId) return <IdentityAvatar {...props} src={props.src ?? agentAvatarUrl(agentId)} />;
  if (presence && props.userId) return <PersonWithPresence {...props} userId={props.userId} />;
  return <IdentityAvatar {...props} />;
}

function PersonWithPresence(props: IdentityAvatarProps & { userId: string }) {
  const online = useMemberOnline(props.userId);
  return (
    <IdentityAvatar
      {...props}
      // No dot until presence is known: an unknown state is never drawn as offline.
      status={online === undefined ? undefined : online ? "online" : "offline"}
    />
  );
}

function AgentWithPresence({
  agentId,
  name,
  src,
  deleted,
  size,
  className,
}: IdentityAvatarProps & { agentId: string }) {
  // That one Agent's live display, so another Agent's activity never repaints this face.
  const display = useLiveAgentDisplay(agentId);
  return (
    <AgentDisplayAvatar
      agentId={agentId}
      name={name ?? ""}
      src={src}
      display={display}
      deleted={deleted}
      size={size}
      className={className}
    />
  );
}
