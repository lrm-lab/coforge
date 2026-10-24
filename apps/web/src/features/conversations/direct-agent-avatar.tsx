import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import { AgentMascotAvatar } from "#src/features/agents/agent-mascot-avatar";
import type { LiveAgent } from "#src/features/agents/workspace-agents-realtime";
import { useRowHovered } from "./row-hover";

/**
 * The face of a Direct-message row with an Agent: its moving mascot, which reacts to the pointer
 * being anywhere over the row (`useRowHovered`). The row already holds the live Agent, so its
 * `display` and `mascot` come down as props; nothing here subscribes to the roster. An Agent
 * without a `mascot` on the row stays a still picture.
 */
export function DirectAgentAvatar({ agent }: { agent: LiveAgent }) {
  const hovered = useRowHovered();
  return agent.mascot ? (
    <AgentMascotAvatar
      mascot={agent.mascot}
      name={agent.displayName}
      display={agent.display}
      cornerDot
      announced
      hovered={hovered}
      className="avatar-dm"
    />
  ) : (
    <AgentDisplayAvatar
      agentId={agent.id}
      name={agent.displayName}
      src={agent.avatarUrl}
      display={agent.display}
      className="avatar-dm"
    />
  );
}
