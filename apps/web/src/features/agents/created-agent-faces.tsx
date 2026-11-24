import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { ActorAvatarStack, AVATAR_STACK_LIMIT } from "#src/features/avatars/actor-avatar-stack";
import { AVATAR_STACK_RING } from "#src/features/avatars/avatar-stack-ring";

export function CreatedAgentFaces({
  agents,
}: {
  agents: readonly { id: string; name: string; avatarUrl: string | null }[];
}) {
  const shown = agents.slice(0, AVATAR_STACK_LIMIT);
  const more = agents.length - shown.length;
  return (
    <ActorAvatarStack more={more} moreLabel={more > 0 ? `+${more}` : undefined}>
      {shown.map((agent) => (
        <ActorAvatar
          presence={false}
          key={agent.id}
          agentId={agent.id}
          size="xs"
          src={agent.avatarUrl}
          alt={agent.name}
          name={agent.name}
          className={AVATAR_STACK_RING.outline}
        />
      ))}
    </ActorAvatarStack>
  );
}
