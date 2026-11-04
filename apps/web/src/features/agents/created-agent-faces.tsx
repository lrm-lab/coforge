import { ActorAvatar } from "#src/features/avatars/actor-avatar";

/** The Agents a person created, as a row of small mascot stickers named by their alt text, or
 * "-" when there are none (Settings → Account). */
export function CreatedAgentFaces({
  agents,
}: {
  agents: readonly { id: string; name: string; avatarUrl: string | null }[];
}) {
  if (agents.length === 0) return "-";
  return agents.map((agent) => (
    <ActorAvatar
      presence={false}
      key={agent.id}
      size="xs"
      src={agent.avatarUrl}
      alt={agent.name}
      name={agent.name}
    />
  ));
}
