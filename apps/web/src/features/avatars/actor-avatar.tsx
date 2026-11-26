import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { useLiveAgentAvatarView } from "#src/features/agents/agent-status-floor";
import { useMemberOnline } from "#src/features/workspaces/member-presence";
import { IdentityAvatar, type IdentityAvatarProps } from "./identity-avatar";

type ActorAvatarProps = Omit<IdentityAvatarProps, "status" | "badge"> & {
  presence: boolean;
  agentId?: string;
};

export function ActorAvatar({ presence, agentId, ...props }: ActorAvatarProps) {
  if (agentId && presence) return <AgentWithPresence {...props} agentId={agentId} />;
  if (agentId) return <IdentityAvatar {...props} src={props.src ?? agentAvatarUrl(agentId)} />;
  if (presence && props.userId) return <PersonWithPresence {...props} userId={props.userId} />;
  return <IdentityAvatar {...props} />;
}

function PersonWithPresence(props: IdentityAvatarProps & { userId: string }) {
  const online = useMemberOnline(props.userId);
  return (
    <IdentityAvatar
      {...props}
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
  const view = useLiveAgentAvatarView(agentId);
  return (
    <AgentDisplayAvatar
      agentId={agentId}
      name={name ?? ""}
      src={src}
      view={view}
      deleted={deleted}
      size={size}
      className={className}
    />
  );
}
