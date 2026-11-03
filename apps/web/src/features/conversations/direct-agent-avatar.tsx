import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import { AgentMascotAvatar } from "#src/features/agents/agent-mascot-avatar";
import {
  useVisibleAgentDisplay,
  type AgentDirectoryEntry,
} from "#src/features/agents/workspace-agents-realtime";
import { useRowHovered } from "./row-hover";

/**
 * The face of a Direct-message row with an Agent: its moving mascot, which reacts to the pointer
 * being anywhere over the row (`useRowHovered`). The row knows who the Agent is; this reads the
 * Agent's live display itself, so a display update repaints this face alone, not the directory
 * (task #433). An Agent without a `mascot` on the row stays a still picture.
 */
export function DirectAgentAvatar({ agent }: { agent: AgentDirectoryEntry }) {
  const hovered = useRowHovered();
  const display = useVisibleAgentDisplay(agent.id);
  return agent.mascot ? (
    <AgentMascotAvatar
      mascot={agent.mascot}
      name={agent.displayName}
      display={display}
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
      display={display}
      className="avatar-dm"
    />
  );
}
