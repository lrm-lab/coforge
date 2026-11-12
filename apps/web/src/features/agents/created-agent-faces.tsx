import { ActorAvatar } from "#src/features/avatars/actor-avatar";

/** The Agents a person created, as a row of small mascot stickers named by their alt text
 * (Settings → Account, which leaves the row out when there are none). */
export function CreatedAgentFaces({
  agents,
}: {
  agents: readonly { id: string; name: string; avatarUrl: string | null }[];
}) {
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
